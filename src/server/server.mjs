/**
 * MOVIE2SHORT Studio — Backend Server
 *
 * Vanilla Node HTTP server + WebSocket. Mengontrol pipeline sebagai subprocess:
 *   1. Analysis (Gemini/llava) -> manifest.json
 *   2. TTS via HTTP API (audiocpp_server on host) -> narration wav + json
 *   3. Render FFmpeg (narasi master timeline)
 *   4. Caption tscaps (headless, template Loki) -> final_captioned_loki.mp4
 *
 * Endpoints:
 *   POST /api/upload?name=<file.mp4>   raw body -> data/uploads/<name>
    *   POST /api/run                      { videoPath, model, stretch, hzoom, caption, ttsModel } -> { jobId }
  *   POST /api/preview-frame            { videoPath, stretch?, hzoom?, atSec? } -> { image(dataURL) }
  *   POST /api/add-bgm                  { jobId, musicPath, level? } -> { ok, name }
 *   GET  /api/jobs/:id                 status + artifacts job
 *   GET  /api/outputs                  daftar job terakhir
 *   WS   /ws?job=<jobId>               stream log live
 *   GET  /files/<jobId>/<name>         serve artifact (video hasil, srt, dll)
 *   GET  /*                            static frontend dari server/public/
 *
 * Jalankan:  node server/server.mjs        (atau: npm run dev:ui)
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { initDb, insertJob, updateJob, getJob as dbGetJob, listJobs as dbListJobs, appendLog as dbAppendLog, addArtifact as dbAddArtifact, getJobLogs as dbGetJobLogs, getJobArtifacts as dbGetJobArtifacts, closeDb, insertOverlayTemplate as dbInsertOverlayTemplate, updateOverlayTemplate as dbUpdateOverlayTemplate, deleteOverlayTemplate as dbDeleteOverlayTemplate, listOverlayTemplates as dbListOverlayTemplates, getOverlayTemplate as dbGetOverlayTemplate } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const UPLOAD_DIR = path.join(ROOT, "data", "uploads");
const JOBS_DIR = path.join(ROOT, "data", "output", "jobs");
const DB_DIR = process.env.DB_DIR || path.join(ROOT, "data");

// ---------------------------------------------------------------------------
// Konfigurasi pipeline (bisa dioverride via env)
// ---------------------------------------------------------------------------
const CFG = {
  tsxCli: path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
  // TTS via HTTP API (audiocpp_server on host)
  httpTtsScript: path.join(ROOT, "src", "tts", "tts.mjs"),
  refAudio: path.join(ROOT, "data", "reference", "test_snippet.wav"),
  refText: path.join(ROOT, "data", "reference", "test_snippet.txt"),
  tscapsTemplates: process.env.TSCAPS_TEMPLATES_DIR || path.join(ROOT, "src", "templates"),
  tscapsChrome: process.env.TSCAPS_CHROME_PATH || (() => {
    const pwBase = process.env.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright";
    try {
      const dirs = fs.readdirSync(pwBase).filter((d) => d.startsWith("chromium-"));
      if (dirs.length) {
        const latest = dirs.sort().pop();
        const linuxPath = path.join(pwBase, latest, "chrome-linux", "chrome");
        if (fs.existsSync(linuxPath)) return linuxPath;
        const winPath = path.join(pwBase, latest, "chrome-win64", "chrome.exe");
        if (fs.existsSync(winPath)) return winPath;
      }
    } catch {}
    return "";
  })(),
  playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || "",
};

await fsp.mkdir(UPLOAD_DIR, { recursive: true });
await fsp.mkdir(JOBS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database + Job store
// ---------------------------------------------------------------------------
await initDb(DB_DIR);

// In-memory runtime state (process refs, WebSocket log buffers)
const runtime = new Map(); // jobId -> { _proc, logBuffer[] }
let pumping = false; // guard antrean FIFO (dideklarasi awal agar startup recovery bisa pakai)

/** Load persisted jobs from SQLite on startup. Scans filesystem for legacy jobs not yet in DB. */
function loadPersistedJobs() {
  // 1. Check if there are any jobs in DB already
  const existingCount = dbListJobs(1).length;

  // 2. Scan filesystem for jobs not yet in DB (migration from file-only storage)
  let entries;
  try { entries = fs.readdirSync(JOBS_DIR, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(JOBS_DIR, e.name);
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    // Skip if already in DB
    if (dbGetJob(e.name)) continue;
    // Scan artifacts
    const files = fs.readdirSync(dir);
    const artifacts = [];
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      const kind =
        ext === ".mp4" ? "video" :
        ext === ".srt" ? "srt" :
        ext === ".wav" ? "audio" :
        ext === ".json" ? "json" :
        ext === ".txt" ? "text" : null;
      if (kind) artifacts.push({ name: f, path: path.join(dir, f), kind });
    }
    if (artifacts.length === 0) continue;
    const stat = fs.statSync(dir);
    const hasFinalVideo = artifacts.some((a) => /final_captioned|final_short/.test(a.name));
    const id = e.name;
    insertJob({
      id,
      dir,
      status: hasFinalVideo ? "done" : "error",
      videoPath: null,
      config: null,
      createdAt: new Date(stat.mtimeMs).toISOString(),
    });
    updateJob(id, {
      stage: hasFinalVideo ? "caption" : "tts",
      error: hasFinalVideo ? null : "Incomplete — restored from disk without final video output",
      finishedAt: hasFinalVideo ? new Date().toISOString() : null,
    });
    dbAppendLog(id, {
      t: new Date().toISOString(),
      level: hasFinalVideo ? "info" : "warn",
      line: hasFinalVideo
        ? `[restored] job selesai dimuat ulang dari disk (${artifacts.length} artifact)`
        : `[restored] job tidak lengkap — tidak ada final video (${artifacts.length} artifact)`,
    });
    for (const a of artifacts) dbAddArtifact(id, a);
  }
}
loadPersistedJobs();

// Job yatim (mati saat server restart): tandai error + jalankan antrean.
for (const j of dbListJobs(100)) {
  if (j.status === "running") {
    updateJob(j.id, { status: "error", error: "terinterupsi restart server", finishedAt: new Date().toISOString() });
  }
}
pumpQueue();

function createJob(videoPath, config) {
  const id = `${Date.now()}-${randomUUID().slice(0, 6)}`;
  const dir = path.join(JOBS_DIR, id);
  insertJob({ id, dir, status: "queued", videoPath, config, createdAt: new Date().toISOString() });
  runtime.set(id, { _proc: null, logBuffer: [] });
  return dbGetJob(id);
}

// ---------------------------------------------------------------------------
// Antrean FIFO — tetap 1 job jalan (host RAM/VRAM terbatas), sisanya menunggu.
// ---------------------------------------------------------------------------
function queuePosition(jobId) {
  const all = dbListJobs(100)
    .filter((j) => j.status === "running" || j.status === "queued")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return all.findIndex((j) => j.id === jobId);
}

async function pumpQueue() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      if (dbListJobs(10).some((j) => j.status === "running")) return;
      const queued = dbListJobs(100).filter((j) => j.status === "queued");
      if (!queued.length) return;
      // created_at DESC -> antrean terlama di akhir
      const next = dbGetJob(queued[queued.length - 1].id);
      if (!next || next.status !== "queued") continue;
      pushLog(next, `[queue] giliran jalan`);
      try {
        await runPipeline(next, next.config || {});
      } catch (e) {
        const cur = dbGetJob(next.id);
        if (cur && cur.status !== "cancelled") {
          updateJob(next.id, { error: e.message });
          pushLog(next, `\n❌ Pipeline error: ${e.message}`, "err");
          pushStatus(next, "error");
        }
      }
    }
  } finally {
    pumping = false;
  }
}

// ---------------------------------------------------------------------------
// WebSocket hub — broadcast log per job
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
const wsClients = new Map(); // jobId -> Set<WebSocket>

function subscribe(jobId, ws) {
  if (!wsClients.has(jobId)) wsClients.set(jobId, new Set());
  wsClients.get(jobId).add(ws);
  ws.on("close", () => {
    const set = wsClients.get(jobId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) wsClients.delete(jobId);
    }
  });
}

function pushLog(job, line, level = "info") {
  const entry = { t: new Date().toISOString(), level, line: String(line).replace(/\r?\n$/, "") };
  dbAppendLog(job.id, entry);
  // Keep short buffer for WebSocket streaming
  const rt = runtime.get(job.id);
  if (rt) {
    rt.logBuffer.push(entry);
    if (rt.logBuffer.length > 4000) rt.logBuffer.splice(0, rt.logBuffer.length - 4000);
  }
  const set = wsClients.get(job.id);
  if (set) {
    const msg = JSON.stringify({ type: "log", jobId: job.id, entry });
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function pushStatus(job, status, stage = job.stage) {
  const finishedAt = (status === "done" || status === "error" || status === "cancelled")
    ? new Date().toISOString() : undefined;
  updateJob(job.id, { status, stage, finishedAt });
  const set = wsClients.get(job.id);
  if (set) {
    const msg = JSON.stringify({ type: "status", jobId: job.id, status, stage: stage ?? job.stage });
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ---------------------------------------------------------------------------
// Subprocess helper — stream stdout/stderr ke log, resolve on exit
// ---------------------------------------------------------------------------
function run(job, label, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    pushLog(job, `\n━━━ [${label}] ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      shell: opts.shell || false,
      windowsHide: true,
    });
    const rt = runtime.get(job.id);
    if (rt) rt._proc = child;
    child.stdout?.on("data", (d) => {
      for (const line of d.toString().split("\n")) if (line.trim()) pushLog(job, line, "out");
    });
    child.stderr?.on("data", (d) => {
      for (const line of d.toString().split("\n")) if (line.trim()) pushLog(job, line, "err");
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}`));
    });
  });
}

function runNode(job, label, script, args, opts = {}) {
  return run(job, label, process.execPath, [CFG.tsxCli, script, ...args], opts);
}

// ---------------------------------------------------------------------------
// Overlay: validasi PNG 9:16 + render HTML/CSS jadi PNG 1080x1920
// ---------------------------------------------------------------------------
function assertOverlayImage(p) {
  const imgPath = path.resolve(String(p || ""));
  if (!imgPath.startsWith(UPLOAD_DIR) || !fs.existsSync(imgPath)) {
    throw new Error("File overlay tidak valid (upload PNG 9:16 dulu).");
  }
  let dims = "";
  try {
    dims = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0", imgPath,
    ], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Overlay bukan file gambar yang valid.");
  }
  const [w, h] = dims.split(",").map(Number);
  if (!(w > 0 && h > 0) || Math.abs(w / h - 9 / 16) > 0.01) {
    throw new Error(`Overlay harus 9:16, dapat ${w}x${h}.`);
  }
  return imgPath;
}

async function renderOverlayHtml(job, partTag, partDir, html, css) {
  const fontsCssUrl = pathToFileURL(path.join(ROOT, "src", "renderer", "fonts.css")).href;
  const page = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${fontsCssUrl}">
<style>
html, body { margin: 0; padding: 0; width: 1080px; height: 1920px; background: transparent; overflow: hidden; }
${css}
</style></head><body>${html}</body></html>`;
  const htmlPath = path.join(partDir, "overlay.html");
  const pngPath = path.join(partDir, "overlay.png");
  await fsp.writeFile(htmlPath, page, "utf8");
  await run(job, `${partTag}OVERLAY SCREENSHOT`, process.execPath, [
    path.join(ROOT, "src", "renderer", "overlay.mjs"),
    "--html", htmlPath,
    "--output", pngPath,
    "--chrome", CFG.tscapsChrome,
  ]);
  return pngPath;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
const BGM_EXTS = new Set([".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"]);

/** Ambil 1 file musik random dari folder (non-rekursif). null bila kosong/tidak ada. */
function pickRandomMusic(dir) {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && BGM_EXTS.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name));
    if (!files.length) return null;
    return files[Math.floor(Math.random() * files.length)];
  } catch {
    return null;
  }
}
async function runPipeline(job, input) {
  const { videoPath, model, stretch, hzoom, caption, lead, tail, outputMode = "one", parts = 0, bgm } = input;
  const minutesPerPart = Number(input.minutesPerPart) > 0 ? Number(input.minutesPerPart) : (Number(process.env.MINUTES_PER_PART) > 0 ? Number(process.env.MINUTES_PER_PART) : 2);
  const defaultBgm = path.join(ROOT, "public", "bgm", "01. Novial Music - Into the Abyss.flac");
  // bgmDir = folder pustaka musik -> pick 1 file random per run.
  let dirPick = null;
  const bgmDir = input.bgmDir || process.env.BGM_DIR;
  if (!bgm && bgmDir) dirPick = pickRandomMusic(bgmDir);
  if (dirPick) pushLog(job, `[bgm] random pick -> ${path.basename(dirPick)}`);
  const bgmPath = bgm ? path.resolve(bgm) : (dirPick || (process.env.BGM_FILE ? path.resolve(process.env.BGM_FILE) : (fs.existsSync(defaultBgm) ? defaultBgm : undefined)));
  // Rekap full-spoiler berdurasi target (menit -> detik). Hanya untuk mode
  // One Short; mode split sudah punya kontrol panjangnya sendiri (minutesPerPart).
  const rawTargetMinutes = Number(input.targetMinutes) > 0 ? Number(input.targetMinutes) : 0;
  const targetSeconds = outputMode === "one" ? Math.round(rawTargetMinutes * 60) : 0;
  const recapLabel = targetSeconds > 0 ? ` | Recap ±${rawTargetMinutes} mnt` : "";
  const chunkEnabled = input.chunk === undefined
    ? true
    : typeof input.chunk === "boolean" ? input.chunk : Number(input.chunk) > 0;
  const chunkDuration = input.chunk === undefined
    ? 40
    : typeof input.chunk === "boolean" ? (input.chunk ? 40 : 0) : Number(input.chunk);
  pushLog(job, `Video  : ${videoPath}`);
  pushLog(job, `Model  : ${model}`);
  const modeLabel = outputMode === "manual" ? `Manual Split (${parts} part)` : outputMode === "auto" ? `Auto Split (target ${minutesPerPart} menit/part)` : "One Short";
  pushLog(job, `Chunk  : ${chunkEnabled ? `${chunkDuration}s (chunk)` : "FULL (tanpa chunk)"} | Output: ${modeLabel}${recapLabel} | Stretch: ${stretch ?? "-"} | hZoom: ${hzoom ?? "-"} | Caption: ${caption ? "ON" : "OFF"} | BGM: ${bgmPath ? path.basename(bgmPath) : "OFF"} | Jeda TTS: lead ${lead ?? 5}s + tail ${tail ?? 5}s`);

  // 0. CAPTION-ONLY (bypass AI: tanpa analysis/TTS/render — anti rate limit) --
  // HARUS di sini (sebelum ANALYSIS) agar VLM tidak terpanggil sama sekali.
  // videoPath = video jadi yang mau di-caption (+acters SRT whisper).
  if (input.captionOnly) {
    const onlyTpl = input.template || "loki";
    const onlyLang = input.language || process.env.LANGUAGE || "Indonesian";
    const onlyOut = path.join(job.dir, `final_captioned_${onlyTpl}.mp4`);
    const onlySrt = path.join(job.dir, `final_captioned_${onlyTpl}.srt`);
    const onlyRel = (p) => path.relative(job.dir, p).split(path.sep).join("/");
    pushStatus(job, "running", "caption");
    await run(job, `CAPTION TSCAPS (${onlyTpl})`, process.execPath, [
      CFG.tsxCli, "src/caption/render.ts",
      "--template", onlyTpl,
      "--video", videoPath,
      "--output", onlyOut,
      "--srt-out", onlySrt,
      "--width", "1080",
      "--height", "1920",
      "--language", onlyLang,
      ...(input.whisperQuality ? ["--whisper-quality", input.whisperQuality] : []),
    ], {
      env: {
        TSCAPS_CHROME_PATH: CFG.tscapsChrome,
        PLAYWRIGHT_BROWSERS_PATH: CFG.playwrightBrowsersPath,
        TSCAPS_TEMPLATES_DIR: CFG.tscapsTemplates,
        TSCAPS_WHISPER_LANGUAGE: onlyLang,
        CHROME_USER_DATA_DIR: process.env.CHROME_USER_DATA_DIR || "/tmp/m2s-chrome-profile",
      },
    });
    pushLog(job, `[caption] selesai -> ${onlyRel(onlyOut)}`);
    dbAddArtifact(job.id, { name: onlyRel(onlyOut), path: onlyOut, kind: "video" });
    if (fs.existsSync(onlySrt)) {
      pushLog(job, `[caption] srt -> ${onlyRel(onlySrt)}`);
      dbAddArtifact(job.id, { name: onlyRel(onlySrt), path: onlySrt, kind: "text" });
    }
    pushStatus(job, "done");
    pushLog(job, `\n✅ Caption-only selesai.`);
    return;
  }

  // 1. ANALYSIS -------------------------------------------------------------

  // 1. ANALYSIS -------------------------------------------------------------
  pushStatus(job, "running", "analysis");
  // RESUME (bypass AI): pakai manifest job lain, analysis dilewati total.
  let resumeManifest = null;
  if (input.resumeJob) {
    const srcManifest = path.join(JOBS_DIR, path.basename(String(input.resumeJob)), "manifest.json");
    if (!fs.existsSync(srcManifest)) throw new Error("resumeJob tidak punya manifest.json");
    const rm = JSON.parse(await fsp.readFile(srcManifest, "utf8"));
    if (!rm.scenes?.length) throw new Error("manifest resume kosong (0 scene)");
    resumeManifest = path.join(job.dir, "manifest.json");
    await fsp.copyFile(srcManifest, resumeManifest);
    pushLog(job, `[resume] manifest dari ${path.basename(String(input.resumeJob))} (${rm.scenes.length} scene), analysis dilewati`);
  }
  const manifestPath = resumeManifest || path.join(job.dir, "manifest.json");
  if (!resumeManifest) {
  await runNode(job, "ANALYSIS", "src/server/analyze.ts", [
    videoPath, job.dir, model,
  ], { env: { CHUNK_DURATION: String(chunkDuration), LANGUAGE: input.language || "Indonesian" } });
  // Cek hasil analysis: manifest.json harus ada & punya scenes
  if (!fs.existsSync(manifestPath)) {
    let detail = "manifest.json tidak dibuat oleh analysis.";
    try {
      const stage1 = JSON.parse(await fsp.readFile(path.join(job.dir, "manifest_stage1.json"), "utf8"));
      if (!stage1.scenes?.length) {
        detail = `Analysis menghasilkan 0 scene. ${model.startsWith("gemini/") ? "Cek GEMINI_API_KEY di .env atau coba model llava:7b." : "Cek Ollama berjalan (llava:7b) atau coba model gemini/gemini-3.6-flash."}`;
      }
    } catch {}
    throw new Error(detail);
  }
  // Validasi tambahan: manifest bisa lolos tapi berisi 0 scene (mis. kuota
  // Gemini habis/429 di tengah analisis) — gagalkan lebih awal dengan hint.
  try {
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    if (!manifest.scenes?.length) {
      throw new Error(`Analysis menghasilkan 0 scene. ${model.startsWith("gemini/") ? "Kuota Gemini kemungkinan habis (429) — tunggu reset atau coba model llava:7b." : "Cek Ollama berjalan (llava:7b) atau coba model gemini/gemini-3.6-flash."}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Analysis menghasilkan 0 scene")) throw e;
    throw new Error(`manifest.json tidak valid: ${e instanceof Error ? e.message : String(e)}`);
  }
  pushLog(job, "[analysis] selesai -> manifest.json");
  } // end if (!resumeManifest)

  const rel = (p) => path.relative(job.dir, p).split(path.sep).join("/");

  // 1.5 CONDENSE (opsional) ---------------------------------------------------
  // Satu short FULL-SPOILER berdurasi target dari video panjang: LLM memilih
  // subset scene kunci (awal->tengah->klimaks->akhir) dan memadatkan narasinya
  // ke budget karakter ±target detik. Visual scene asli dipertahankan; render
  // nanti memotong tiap klip ke durasi narasi barunya (narasi = master timeline).
  let effectiveManifest = manifestPath;
  if (targetSeconds > 0) {
    pushStatus(job, "running", "condense");
    const originalSceneCount = (JSON.parse(await fsp.readFile(manifestPath, "utf8"))).scenes.length;
    const condensedPath = path.join(job.dir, "manifest_condensed.json");
    await runNode(job, "CONDENSE RECAP", "src/server/condense_manifest.ts", [
      manifestPath, condensedPath,
      "--seconds", String(targetSeconds),
      "--model", model,
      "--lead", String(lead ?? 5),
      "--tail", String(tail ?? 5),
    ]);
    effectiveManifest = condensedPath;
    // narasi.txt final = hasil kondensasi (bukan narasi analisis penuh).
    const condensed = JSON.parse(await fsp.readFile(condensedPath, "utf8"));
    await fsp.writeFile(
      path.join(job.dir, "narasi.txt"),
      condensed.scenes.map((s) => s.narration_text).join("\n") + "\n",
      "utf8",
    );
    pushLog(job, `[condense] ${condensed.scenes.length}/${originalSceneCount} scene dipertahankan, target ±${targetSeconds}s -> manifest_condensed.json`);
  }

  // 2. TTS SEKALI — HTTP server (audiocpp_server, GPU, Higgs Audio v3) ----
  // Panggil /v1/audio/speech per scene; output IDENTIK dengan versi CLI.
  pushStatus(job, "running", "tts");
  const fullNarrationWav = path.join(job.dir, "narration_audiocpp_natural.wav");
  const fullNarrationJson = path.join(job.dir, "narration_audiocpp_natural.json");
  const httpTtsArgs = [
    CFG.httpTtsScript,
    "--manifest", effectiveManifest,
    "--output", fullNarrationWav,
    "--server", process.env.AUDIOCPP_SERVER || "http://127.0.0.1:8080",
  ];
  if (lead !== undefined && lead !== null) httpTtsArgs.push("--lead", String(lead));
  if (tail !== undefined && tail !== null) httpTtsArgs.push("--tail", String(tail));
  // Language support
  const ttsLanguage = input.language || "Indonesian";
  httpTtsArgs.push("--language", ttsLanguage);
  // Voice cloning support
  const voiceRef = input.voiceRef || process.env.AUDIOCPP_VOICE_REF || path.join(ROOT, "src", "patrick_ref_voice.wav");
  if (voiceRef) httpTtsArgs.push("--voice-ref", voiceRef);
  // Model TTS: API/UI > env > default Higgs. Harus terdaftar di server.json audiocpp.
  const ttsModel = input.ttsModel || process.env.TTS_MODEL || "higgs-tts-q4";
  httpTtsArgs.push("--model", ttsModel);
  pushLog(job, `[tts] model -> ${ttsModel}`);
  await run(job, `TTS HTTP (${ttsModel})`, process.execPath, [...httpTtsArgs]);
  pushLog(job, `[tts] selesai -> ${rel(fullNarrationWav)}`);

  // 2.5 SPLIT post-TTS (opsional) ------------------------------------------------
  const partDirs = [];
  if (outputMode !== "one") {
    pushStatus(job, "running", "split");
    const partsDir = path.join(job.dir, "parts");
    const splitArgs = [
      effectiveManifest, partsDir, String(parts || 0),
      "--narration", fullNarrationJson,
    ];
    if (minutesPerPart > 0) splitArgs.push("--minutes", String(minutesPerPart));
    await runNode(job, "SPLIT MANIFEST", "src/synthesizer/split.ts", splitArgs);
    const entries = await fsp.readdir(partsDir, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && /^part-\d+$/.test(e.name)) partDirs.push(path.join(partsDir, e.name));
    }
    // Potong WAV narasi penuh per part memakai offset kumulatif dari splitter.
    for (const partDir of partDirs) {
      const durInfo = JSON.parse(await fsp.readFile(path.join(partDir, "narration_durations.json"), "utf8"));
      const slicePath = path.join(partDir, "narration_part.wav");
      await run(job, `[${path.basename(partDir)}] SLICE AUDIO`, "ffmpeg", [
        "-nostdin", "-y",
        "-i", fullNarrationWav,
        "-ss", String(durInfo.narrationStartSec),
        "-t", String(durInfo.durationSec),
        "-c:a", "pcm_s16le", slicePath,
      ]);
    }
    pushLog(job, `[split] ${partDirs.length} part siap.`);
  }
  if (partDirs.length === 0) partDirs.push(job.dir);

  const tpl = input.template || "loki";
  for (let p = 0; p < partDirs.length; p += 1) {
    const partDir = partDirs[p];
    const isMulti = partDirs.length > 1;
    const partTag = isMulti ? `[part-${String(p + 1).padStart(2, "0")}/${partDirs.length}] ` : "";
    // One Short + condense: render dari manifest_condensed (bukan manifest penuh),
    // agar durasi target dipatuhi. Mode split: manifest per part dari splitter.
    const partManifest = (partDirs.length === 1 && effectiveManifest && effectiveManifest !== manifestPath)
      ? effectiveManifest
      : path.join(partDir, "manifest.json");
    // Mode split: audio + durations hasil potongan per part.
    // One Short: langsung track penuh dari stage TTS.
    const narrationWav = isMulti ? path.join(partDir, "narration_part.wav") : fullNarrationWav;
    const narrationJson = isMulti ? path.join(partDir, "narration_durations.json") : fullNarrationJson;

    // 3. RENDER FFmpeg (narasi master timeline, per part) -----------------------
    pushStatus(job, "running", "render");
    const finalShort = path.join(partDir, "final_short.mp4");
    const renderArgs = [
      "--only-render", partManifest,
      "--video", videoPath,
      "--audio", narrationWav,
      "--scene-durations", narrationJson,
      "--out", finalShort,
    ];
    if (stretch !== undefined && stretch !== null) renderArgs.push("--stretch", String(stretch));
    if (hzoom !== undefined && hzoom !== null) renderArgs.push("--hzoom", String(hzoom));
    if (bgmPath) renderArgs.push("--bgm", bgmPath);
    if (input.speedMin !== undefined && input.speedMin !== null) renderArgs.push("--speed-min", String(input.speedMin));
    if (input.speedMax !== undefined && input.speedMax !== null) renderArgs.push("--speed-max", String(input.speedMax));
    await runNode(job, `${partTag}RENDER FFMPEG`, "src/index.ts", renderArgs);
    pushLog(job, `${partTag}[render] selesai -> ${rel(finalShort)}`);
    dbAddArtifact(job.id, { name: rel(finalShort), path: finalShort, kind: "video" });

    // 4. OVERLAY opsional (SEBELUM caption): gambar PNG 9:16 atau HTML+CSS
    // full-custom (kanvas 1080x1920 transparan -> screenshot -> tempel).
    let captionInput = finalShort;
    const overlayMode = input.overlayMode === "image" || input.overlayMode === "css" ? input.overlayMode : "none";
    if (overlayMode !== "none") {
      pushStatus(job, "running", "overlay");
      const finalOverlay = path.join(partDir, "final_overlay.mp4");
      let overlayPng = null;
      if (overlayMode === "image") {
        overlayPng = assertOverlayImage(input.overlayImage);
      } else {
        const html = String(input.overlayHtml || "");
        const css = String(input.overlayCss || "");
        if (!html.trim() && !css.trim()) throw new Error("Overlay CSS kosong (isi HTML/CSS dulu).");
        overlayPng = await renderOverlayHtml(job, partTag, partDir, html, css);
      }
      await run(job, `${partTag}OVERLAY FFMPEG`, "ffmpeg", [
        "-nostdin", "-y",
        "-i", finalShort,
        "-i", overlayPng,
        "-filter_complex", "[1:v]format=rgba,scale=1080:1920[ov];[0:v][ov]overlay=0:0:format=yuv420",
        "-c:a", "copy", finalOverlay,
      ]);
      pushLog(job, `${partTag}[overlay] selesai -> ${rel(finalOverlay)}`);
      dbAddArtifact(job.id, { name: rel(finalOverlay), path: finalOverlay, kind: "video" });
      captionInput = finalOverlay;
    }

    // 5. CAPTION tscaps headless (per part, template pilihan user) ---------------
    if (caption) {
      pushStatus(job, "running", "caption");
      const capName = `final_captioned_${tpl}.mp4`;
      const finalCaptioned = path.join(partDir, capName);
      const finalSrt = path.join(partDir, `final_captioned_${tpl}.srt`);
      try {
        await run(job, `${partTag}CAPTION TSCAPS (${tpl})`, process.execPath, [
          CFG.tsxCli, "src/caption/render.ts",
          "--template", tpl,
          "--video", captionInput,
          "--output", finalCaptioned,
          "--srt-out", finalSrt,
          "--width", "1080",
          "--height", "1920",
          "--language", input.language || process.env.LANGUAGE || "Indonesian",
          ...(input.whisperQuality ? ["--whisper-quality", input.whisperQuality] : []),
        ], {
          env: {
            TSCAPS_CHROME_PATH: CFG.tscapsChrome,
            PLAYWRIGHT_BROWSERS_PATH: CFG.playwrightBrowsersPath,
            TSCAPS_TEMPLATES_DIR: CFG.tscapsTemplates,
            TSCAPS_WHISPER_LANGUAGE: ttsLanguage,
            CHROME_USER_DATA_DIR: process.env.CHROME_USER_DATA_DIR || "/tmp/m2s-chrome-profile",
          },
        });
        pushLog(job, `${partTag}[caption] selesai -> ${rel(finalCaptioned)}`);
        dbAddArtifact(job.id, { name: rel(finalCaptioned), path: finalCaptioned, kind: "video" });
        if (fs.existsSync(finalSrt)) {
          pushLog(job, `${partTag}[caption] srt -> ${rel(finalSrt)}`);
          dbAddArtifact(job.id, { name: rel(finalSrt), path: finalSrt, kind: "text" });
        }
      } catch (e) {
        pushLog(job, `${partTag}[caption] gagal (video tetap tersedia tanpa caption): ${e.message}`, "warn");
      }
    }

    // Artifacts pendukung per part
    for (const [p, kind] of [
      [partManifest, "json"],
      [path.join(partDir, "narasi.txt"), "text"],
      [narrationWav, "audio"],
      [narrationJson, "json"],
    ]) {
      if (fs.existsSync(p)) dbAddArtifact(job.id, { name: rel(p), path: p, kind });
    }
  }

  pushStatus(job, "done");
  pushLog(job, `\n✅ Pipeline selesai (${partDirs.length} part).`);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".srt": "application/x-subrip; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // --- CORS: frontend editor (tscaps-web di localhost:5173) -----------------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API: upload video ----------------------------------------------------
  if (pathname === "/api/upload" && req.method === "POST") {
    const name = path.basename(url.searchParams.get("name") || "upload.mp4");
    // dir dibatasi ke uploads|bgm (cegah path traversal).
    const dirKey = url.searchParams.get("dir") === "bgm" ? "bgm" : "uploads";
    const destDir = dirKey === "bgm" ? path.join(ROOT, "data", "bgm") : UPLOAD_DIR;
    await fsp.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, name);
    try {
      const w = fs.createWriteStream(dest);
      req.pipe(w);
      await new Promise((resolve, reject) => {
        w.on("finish", resolve);
        w.on("error", reject);
        req.on("error", reject);
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, videoPath: dest, name }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // --- API: preview 1 frame dengan filter render (stretch/hzoom) ------------
  // Body: { videoPath, stretch?, hzoom?, atSec? } -> { ok, image(dataURL), atSec }
  // Filter IDENTIK dengan src/renderer/renderer.ts (tanpa camera plan: tengah).
  if (pathname === "/api/preview-frame" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let input;
    try { input = JSON.parse(body); } catch { input = {}; }
    const videoPath = input.videoPath;
    if (!videoPath || !fs.existsSync(videoPath)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "videoPath tidak valid" }));
      return;
    }
    const num = (v) => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v.replace(",", "."));
        if (Number.isFinite(n)) return n;
      }
      return undefined;
    };
    const stretch = num(input.stretch);
    const hzoom = num(input.hzoom);
    const W = 1080, H = 1920, foregroundZoom = 1.15;
    const useStretch = stretch !== undefined && stretch >= 0;
    let filter;
    if (useStretch) {
      const hz = hzoom !== undefined && hzoom > 1 ? hzoom : 1;
      const fgH = Math.round(608 + (1920 - 608) * Math.min(1, Math.max(0, stretch)));
      const fgW = Math.round(W * hz);
      filter = `[0:v]split=2[bg_src][fg_src];[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=50[bga];[bga]eq=brightness=-0.3[bg];[fg_src]scale=${fgW}:${fgH},crop=${W}:${fgH}[fg];[bg][fg]overlay=0:${Math.round((H - fgH) / 2)}:format=auto[outv]`.replace(/\s+/g, "");
    } else {
      filter = `[0:v]split=2[bg_src][fg_src];[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=50[bga];[bga]eq=brightness=-0.3[bg];[fg_src]scale=${W}:${H}:force_original_aspect_ratio=decrease,scale=iw*${foregroundZoom}:ih*${foregroundZoom}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto[outv]`.replace(/\s+/g, "");
    }
    try {
      const durOut = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath], { encoding: "utf8" });
      const dur = Number(durOut.trim()) || 10;
      const atSec = Math.min(Math.max(num(input.atSec) ?? 10, 0), Math.max(0, dur - 0.5));
      const tmpPng = path.join(os.tmpdir(), `m2s-preview-${Date.now()}.png`);
      execFileSync("ffmpeg", ["-nostdin", "-y", "-ss", String(atSec), "-i", videoPath, "-frames:v", "1", "-filter_complex", filter, "-map", "[outv]", tmpPng], { stdio: "pipe" });
      const b64 = fs.readFileSync(tmpPng).toString("base64");
      try { fs.unlinkSync(tmpPng); } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, image: `data:image/png;base64,${b64}`, atSec, stretch, hzoom }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 300) }));
    }
    return;
  }

  // --- API: jalankan pipeline -----------------------------------------------
  if (pathname === "/api/run" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let input;
    try { input = JSON.parse(body); } catch { input = {}; }
    const videoPath = input.videoPath;
    if (!videoPath || !fs.existsSync(videoPath)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "videoPath tidak valid" }));
      return;
    }
    // Tanpa guard 409: job masuk antrean FIFO, worker jalan satu per satu.
    const sanitized = {
      videoPath,
      model: input.model || process.env.MODEL_NAME || "gemini/gemini-3.6-flash",
      chunk: input.chunk !== undefined
        ? (typeof input.chunk === "boolean" ? input.chunk : Number(input.chunk))
        : true, // true = 40s chunks; false = full video
      stretch: input.stretch !== undefined ? Number(input.stretch) : undefined,
      hzoom: input.hzoom !== undefined ? Number(input.hzoom) : undefined,
      speedMin: input.speedMin !== undefined && Number.isFinite(Number(String(input.speedMin).replace(",", "."))) ? Number(String(input.speedMin).replace(",", ".")) : undefined,
      speedMax: input.speedMax !== undefined && Number.isFinite(Number(String(input.speedMax).replace(",", "."))) ? Number(String(input.speedMax).replace(",", ".")) : undefined,
      caption: input.caption !== false,
      template: typeof input.template === "string" ? input.template : "loki",
      whisperQuality: ["tiny", "base", "small", "medium"].includes(input.whisperQuality) ? input.whisperQuality : undefined,
      lead: input.lead !== undefined ? Number(input.lead) : 5,
      tail: input.tail !== undefined ? Number(input.tail) : 5,
      outputMode: input.outputMode === "auto" || input.outputMode === "manual" ? input.outputMode : "one",
      parts: input.parts !== undefined ? Number(input.parts) : (Number(process.env.PARTS) > 0 ? Number(process.env.PARTS) : 0),
      minutesPerPart: Number(input.minutesPerPart) > 0 ? Number(input.minutesPerPart) : (Number(process.env.MINUTES_PER_PART) > 0 ? Number(process.env.MINUTES_PER_PART) : 2),
      targetMinutes: input.targetMinutes !== undefined ? (Number(input.targetMinutes) > 0 ? Number(input.targetMinutes) : 0) : (Number(process.env.TARGET_MINUTES) > 0 ? Number(process.env.TARGET_MINUTES) : 3),
      bgm: input.bgm ? String(input.bgm) : undefined,
      bgmDir: input.bgmDir ? String(input.bgmDir) : undefined,
      overlayMode: input.overlayMode === "image" || input.overlayMode === "css" ? input.overlayMode : "none",
      overlayImage: input.overlayImage ? String(input.overlayImage) : undefined,
      overlayHtml: input.overlayHtml ? String(input.overlayHtml).slice(0, 200000) : undefined,
      overlayCss: input.overlayCss ? String(input.overlayCss).slice(0, 200000) : undefined,
       voiceRef: input.voiceRef ? String(input.voiceRef) : undefined,
      ttsModel: typeof input.ttsModel === "string" && input.ttsModel.trim() ? input.ttsModel.trim() : undefined,
      language: (input.language || process.env.LANGUAGE || "Indonesian").toString(),
      captionOnly: input.captionOnly === true,
      resumeJob: typeof input.resumeJob === "string" && input.resumeJob.trim() ? path.basename(input.resumeJob.trim()) : undefined,
    };
    const job = createJob(videoPath, sanitized);
    await fsp.mkdir(job.dir, { recursive: true });
    const pos = queuePosition(job.id);
    pushLog(job, pos <= 0 ? `[queue] langsung jalan` : `[queue] menunggu giliran (antrean #${pos})`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, jobId: job.id, queued: pos > 0, position: pos < 0 ? 0 : pos }));
    pumpQueue();
    return;
  }

  // --- API: tambah/ganti BGM ke video jadi (tanpa AI, ffmpeg mix) -----------
  // Body: { jobId, musicPath?, musicDir?, level? } -> { ok, name, picked? }
  // musicPath = hasil /api/upload. musicDir = folder -> 1 file random.
  if (pathname === "/api/add-bgm" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let input;
    try { input = JSON.parse(body); } catch { input = {}; }
    const job = input.jobId ? dbGetJob(String(input.jobId)) : null;
    let musicPath = input.musicPath;
    let picked = null;
    if (!musicPath && input.musicDir) {
      picked = pickRandomMusic(String(input.musicDir));
      if (picked) musicPath = picked;
    }
    if (!job) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "job tidak ditemukan" }));
      return;
    }
    if (job.status === "running") {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "tunggu job selesai dulu" }));
      return;
    }
    if (!musicPath || !fs.existsSync(musicPath)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "musik tidak valid (isi musicPath via /api/upload, atau musicDir berisi mp3/wav/flac)" }));
      return;
    }
    const level = Math.min(1, Math.max(0, Number(input.level) > 0 ? Number(input.level) : 0.2));
    const arts = dbGetJobArtifacts(job.id);
    const pick = (re) => arts.map((a) => a.path).find((p) => re.test(path.basename(p)) && fs.existsSync(p));
    const srcVideo = pick(/^final_captioned_.*\.mp4$/) || pick(/^final_short\.mp4$/) || pick(/\.mp4$/);
    if (!srcVideo) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "job ini tidak punya video" }));
      return;
    }
    const outName = "final_with_bgm.mp4";
    const outPath = path.join(job.dir, outName);
    try {
      execFileSync("ffmpeg", [
        "-nostdin", "-y",
        "-i", srcVideo,
        "-stream_loop", "-1",
        "-i", musicPath,
        "-filter_complex", `[1:a]volume=${level}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
        "-map", "0:v", "-map", "[a]",
        "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart",
        outPath,
      ], { stdio: "pipe" });
      if (!arts.some((a) => a.name === outName)) {
        dbAddArtifact(job.id, { name: outName, path: outPath, kind: "video" });
      }
      pushLog(job, `[bgm] ${path.basename(srcVideo)} + ${path.basename(musicPath)} (level ${level}) -> ${outName}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: outName, picked: picked ? path.basename(picked) : undefined }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 300) }));
    }
    return;
  }

  // --- API: batalkan job --------------------------------------------------------
  const cancelMatch = pathname.match(/^\/api\/jobs\/([\w-]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const job = dbGetJob(cancelMatch[1]);
    if (!job) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "job not found" }));
      return;
    }
    const rt = runtime.get(job.id);
    if (job.status === "running" && rt?._proc) {
      try { rt._proc.kill(); } catch {}
    }
    updateJob(job.id, { status: "cancelled", finishedAt: new Date().toISOString() });
    pushLog(job, "\n⛔ Job dibatalkan oleh user.", "warn");
    pushStatus(job, "cancelled");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    pumpQueue();
    return;
  }

  // --- API: daftar template tscaps ----------------------------------------------
  if (pathname === "/api/templates" && req.method === "GET") {
    try {
      const tplDir = CFG.tscapsTemplates;
      const entries = await fsp.readdir(tplDir, { withFileTypes: true });
      const templates = [];
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith("_")) continue;
        const tplJsonPath = path.join(tplDir, e.name, "template.json");
        if (!fs.existsSync(tplJsonPath)) continue;
        try {
          const meta = JSON.parse(await fsp.readFile(tplJsonPath, "utf8"));
          const colors = (meta.styleControls || [])
            .filter((c) => c.type === "color" && c.default)
            .map((c) => c.default);
          const swatch = colors.length >= 2
            ? `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`
            : colors[0] || "#888";
          // kirim css + config + filters untuk preview asli di browser
          const cssPath = path.join(tplDir, e.name, "style.css");
          const css = fs.existsSync(cssPath) ? await fsp.readFile(cssPath, "utf8") : "";
          const filtersPath = path.join(tplDir, e.name, "filters.svg");
          const filters = fs.existsSync(filtersPath) ? await fsp.readFile(filtersPath, "utf8") : "";
          templates.push({ id: e.name, name: meta.name || e.name, swatch, css, filters, json: meta });
        } catch {}
      }
      templates.sort((a, b) => a.id.localeCompare(b.id));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, templates }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // --- API: status job --------------------------------------------------------
  const jobMatch = pathname.match(/^\/api\/jobs\/([\w-]+)$/);
  if (jobMatch) {
    const job = dbGetJob(jobMatch[1]);
    if (!job) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "job not found" }));
      return;
    }
    const artifacts = dbGetJobArtifacts(job.id);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      job: {
        id: job.id,
        status: job.status,
        stage: job.stage,
        error: job.error,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        artifacts,
      },
    }));
    return;
  }

  // --- API: daftar jobs --------------------------------------------------------
  if (pathname === "/api/jobs" && req.method === "GET") {
    const rows = dbListJobs(20);
    const list = rows.map((j) => ({
      id: j.id,
      status: j.status,
      stage: j.stage,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      artifacts: dbGetJobArtifacts(j.id).map((a) => a.name),
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, jobs: list }));
    return;
  }

  // --- API: daftar output (job selesai + video final) --------------------------
  if (pathname === "/api/outputs" && req.method === "GET") {
    const rows = dbListJobs(50);
    const list = [];
    for (const j of rows) {
      const arts = dbGetJobArtifacts(j.id).filter((a) => a.kind === "video");
      if (!arts.length) continue;
      list.push({
        id: j.id,
        status: j.status,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
        videos: arts.map((a) => a.name),
      });
      if (list.length >= 20) break;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, outputs: list }));
    return;
  }

  // --- API: log job ------------------------------------------------------------
  const logMatch = pathname.match(/^\/api\/jobs\/([\w-]+)\/log$/);
  if (logMatch) {
    const job = dbGetJob(logMatch[1]);
    if (!job) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    const log = dbGetJobLogs(job.id);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, log }));
    return;
  }

  // --- API: overlay templates --------------------------------------------------
  if (pathname === "/api/overlay-templates" && req.method === "GET") {
    const rows = dbListOverlayTemplates();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, templates: rows }));
    return;
  }

  if (pathname === "/api/overlay-templates" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let input;
    try { input = JSON.parse(body); } catch { input = {}; }
    if (!input.name || !input.html || !input.css) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "name, html, css required" }));
      return;
    }
    const id = input.id || `tpl_${Date.now()}`;
    const now = new Date().toISOString();
    dbInsertOverlayTemplate({
      id, name: input.name, description: input.description ?? "",
      html: input.html.slice(0, 200000), css: input.css.slice(0, 200000),
      createdAt: now, updatedAt: now,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, id }));
    return;
  }

  if (pathname === "/api/overlay-templates/save" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let input;
    try { input = JSON.parse(body); } catch { input = {}; }
    if (!input.id || !input.html || !input.css) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "id, html, css required" }));
      return;
    }
    dbUpdateOverlayTemplate(input.id, {
      name: input.name, description: input.description,
      html: input.html.slice(0, 200000), css: input.css.slice(0, 200000),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const tplMatch = pathname.match(/^\/api\/overlay-templates\/([\w-]+)$/);
  if (tplMatch && req.method === "DELETE") {
    dbDeleteOverlayTemplate(tplMatch[1]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (tplMatch && req.method === "GET") {
    const row = dbGetOverlayTemplate(tplMatch[1]);
    if (!row) { res.writeHead(404); res.end(JSON.stringify({ ok: false })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, template: row }));
    return;
  }

  // --- API: serve artifact --------------------------------------------------------
  // name boleh mengandung subfolder (mis. part-01/final_short.mp4)
  const fileMatch = pathname.match(/^\/files\/([\w-]+)\/(.+)$/);
  if (fileMatch) {
    const [, jobId, fileName] = fileMatch;
    const job = dbGetJob(jobId);
    const safeName = path.normalize(fileName).replace(/^([.][.][/\\])+/, "").replace(/\\/g, "/");
    const artifacts = job ? dbGetJobArtifacts(jobId) : [];
    const candidate = artifacts.find((a) => a.name === safeName);
    if (!candidate) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "artifact not found" }));
      return;
    }
    const ext = path.extname(safeName).toLowerCase();
    const stat = fs.statSync(candidate.path);
    const size = stat.size;
    // Dukungan Range (seek video besar) — single range saja, cukup untuk <video>
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= size) end = size - 1;
      if (start > end) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "content-type": MIME[ext] || "application/octet-stream",
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      });
      fs.createReadStream(candidate.path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": size,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    fs.createReadStream(candidate.path).pipe(res);
    return;
  }

  // --- API: serve static frontend ----------------------------------------------
  const FRONTEND_CANDIDATES = [
    path.join(ROOT, "studio", "web", "dist"),
  ];
  function resolveFrontendFile(requestPath) {
    for (const base of FRONTEND_CANDIDATES) {
      const p = path.join(base, requestPath === "/" ? "index.html" : requestPath);
      try {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          const idx = path.join(p, "index.html");
          fs.statSync(idx);
          return idx;
        }
        return p;
      } catch {}
    }
    return null;
  }
  function resolveFrontendIndex() {
    for (const base of FRONTEND_CANDIDATES) {
      const idx = path.join(base, "index.html");
      try {
        fs.statSync(idx);
        return idx;
      } catch {}
    }
    return null;
  }
  if (req.method === "GET") {
    const filePath = resolveFrontendFile(pathname);
    if (filePath) {
      try {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "content-type": MIME[ext] || "text/html" });
        fs.createReadStream(filePath).pipe(res);
        return;
      } catch {}
    }
    // Fallback to index.html for SPA routing
    const index = resolveFrontendIndex();
    if (index) {
      try {
        res.writeHead(200, { "content-type": "text/html" });
        fs.createReadStream(index).pipe(res);
        return;
      } catch {}
    }
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

// Upgrade HTTP -> WebSocket
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const jobId = url.searchParams.get("job");
  if (!jobId) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => subscribe(jobId, ws));
});

const PORT = process.env.PORT || 3131;
server.listen(PORT, () => {
  console.log(`🎬 MOVIE2SHORT Studio UI`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Jobs   : ${JOBS_DIR}`);
  console.log(`   DB     : ${DB_DIR}`);
  // Warmup: format dok audio C++ (voice_ref path + reference_text).
  // Ref murni dari env (file pilihan user, gonta-ganti) — tanpa aturan detik/nama.
  const ttsServer = process.env.AUDIOCPP_SERVER || "http://127.0.0.1:8080";
  const ttsModel = process.env.TTS_MODEL || "higgs-tts-q4";
  const hostDataDir = (process.env.HOST_DATA_DIR || "").replace(/\\/g, "/").replace(/\/$/, "");
  const warmupBody = { model: ttsModel, input: "warmup", response_format: "wav", language: process.env.LANGUAGE || "Indonesian" };
  try {
    const refPath = process.env.AUDIOCPP_VOICE_REF || path.join(ROOT, "src", "patrick_ref_voice.wav");
    if (refPath && fs.existsSync(refPath)) {
      if (hostDataDir && refPath.startsWith("/app/data")) {
        warmupBody.voice_ref = { type: "path", path: hostDataDir + refPath.slice("/app/data".length) };
      } else {
        const b64 = fs.readFileSync(refPath).toString("base64");
        if (b64.length <= 5 * 1024 * 1024) warmupBody.voice_ref = { type: "base64", data: b64 };
      }
      const refTxt = [refPath.replace(/\.[^.]+$/, ".txt"), `${refPath}.txt`].find((p) => fs.existsSync(p));
      if (warmupBody.voice_ref && refTxt) warmupBody.reference_text = fs.readFileSync(refTxt, "utf8").trim();
    }
  } catch {}
  (async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const r = await fetch(`${ttsServer}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(warmupBody),
          signal: AbortSignal.timeout(120_000),
        });
        if (r.ok) { console.log(`   TTS    : model warmed up (${ttsServer})`); return; }
        console.log(`   TTS    : warmup attempt ${attempt} got ${r.status}, retrying in 5s...`);
      } catch (e) {
        console.log(`   TTS    : warmup attempt ${attempt} failed (${e.message}), retrying in 5s...`);
      }
      await new Promise((ok) => setTimeout(ok, 5000));
    }
    console.log(`   TTS    : warmup skipped after 10 attempts`);
  })();
});

// Graceful shutdown — close DB WAL properly
process.on("SIGINT", () => { closeDb(); process.exit(0); });
process.on("SIGTERM", () => { closeDb(); process.exit(0); });
