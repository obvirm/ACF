/**
 * Condense recap — pilih subset scene kunci + padatkan narasi ke budget detik.
 * Dipanggil server (runPipeline) saat targetMinutes > 0.
 *
 * Usage: node node_modules/tsx/dist/cli.mjs src/server/condense_manifest.ts
 *   <manifest.json> <condensed.json> --seconds <N> [--model <m>] [--lead 5] [--tail 5]
 */
import { config } from "dotenv";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";

config();

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "http://localhost:20128/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Laju bicara TES dari 2 pasangan data riil (omnivoice, suara Patrick):
//   6566 char -> 275,2 dtk;  2705 char -> 116,2 dtk
//   => durasi_video(dtk) ~= lead(5) + char / 24,3
const CHARS_PER_SEC = 24.3;

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

/** Parse JSON jawaban LLM secara robust: buang fence, repair koma gantung
 *  + karakter kontrol, balance kurung. Throw bila tetap gagal. */
export function parseLlmJson(raw: string): any {
  let text = String(raw || "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("LLM tidak mengembalikan JSON");
  let slice = text.slice(first, last + 1);
  const attempts: string[] = [
    slice,
    slice.replace(/,\s*([}\]])/g, "$1"), // koma gantung
    slice.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""), // karakter kontrol
    slice.replace(/,\s*([}\]])/g, "$1").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""),
  ];
  let lastErr: any = null;
  for (const cand of attempts) {
    try { return JSON.parse(cand); } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function main() {
  const [manifestPath, condensedPath] = process.argv.slice(2);
  const seconds = Number(arg("--seconds", "60"));
  const model = arg("--model") || process.env.MODEL_NAME || "ag/gemini-3.6-flash-high";
  if (!manifestPath || !condensedPath || !(seconds > 0)) {
    console.error("usage: condense_manifest.ts <manifest.json> <condensed.json> --seconds <N> [--model <m>]");
    process.exit(1);
  }

  const manifest = JSON.parse(await fs.readFile(path.resolve(manifestPath), "utf8"));
  const scenes = manifest.scenes || [];
  if (!scenes.length) throw new Error("Manifest kosong (0 scene)");

  const leadSec = Math.max(0, Number(arg("--lead", "5")) || 5);
  // Matematika: durasi = lead + karakter/24,3  =>  karakter = (target - lead) x 24,3
  const budgetChars = Math.floor(Math.max(1, seconds - leadSec) * CHARS_PER_SEC);
  const minChars = Math.floor(budgetChars * 0.95);
  const digest = scenes
    .map((s: any) => `[${s.start_sec}s-${s.end_sec}s] ${s.description || ""} || ${s.narration_text || ""}`)
    .join("\n");

  const prompt = `Kamu merangkum video panjang jadi SATU short full-spoiler berdurasi TEPAT ${seconds} detik.

MATEMATIKA WAJIB — hitung sendiri sebelum balas:
- TTS membaca ±${CHARS_PER_SEC} karakter/detik + ${leadSec} detik jeda awal.
- Total karakter narasi yang harus kamu tulis = (${seconds} - ${leadSec}) x ${CHARS_PER_SEC} = ${budgetChars} karakter.
- Rentang keras: ${minChars}-${budgetChars} karakter (SEMUA narration_text scene digabung, dihitung dengan menghitung huruf/spasi satu per satu, bukan perkiraan).
- Lebih dari ${budgetChars} = GAGAL (video melewati ${seconds} detik). Kurang dari ${minChars} = GAGAL (video jauh di bawah target).
- Sebelum balas: JUMLAHKAN total karakter narasimu. Meleset? Tambah/pangkas narasimu SENDIRI (jangan buang scene) sampai masuk rentang.

Aturan:
1. Pilih subset scene KRONOLOGIS (awal->tengah->klimaks->akhir), buang yang tidak penting.
2. Padatkan tiap narration_text (1 kalimat pendek) tapi pertahankan fakta & gaya narasi asli.
3. start_sec/end_sec pakai angka ASLI dari input (jangan ubah).
4. subject_x_pct ikutkan kalau ada.

Daftar scene (format [mulai-akhir] deskripsi || narasi):
${digest}

Balas JSON SAJA: {"scenes":[{"id":"...","start_sec":0,"end_sec":0,"description":"...","narration_text":"...","subject_x_pct":50}]}`;

  // Retry 3x: network/timeout, HTTP 429/5xx, JSON cacat, ATAU jawaban di luar
  // rentang karakter (AI tidak patuh matematika -> disuruh hitung ulang).
  const waits = [10_000, 30_000];
  const charsOf = (sc: any[]) => (sc || []).reduce((a: number, s: any) => a + String(s.narration_text || "").length, 0);
  let parsed: any = null;
  let best: { sc: any[]; dist: number } | null = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: "user", content: prompt + (lastErr.includes("karakter") ? `\n\nPERINGATAN: percobaan sebelumnya GAGAL (${lastErr}). JUMLAHKAN lagi total karakter narasimu dengan teliti sebelum balas!` : "") }],
          // Model reasoning (gemini-pro-agent) menghabiskan budget token —
          // 4096 bikin JSON terpotong (finish: max_tokens). 32768 aman.
          max_tokens: 32768,
        }),
        signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        if (response.status !== 429 && response.status < 500) {
          throw new Error(`LLM condense HTTP ${response.status}: ${errBody.slice(0, 200)}`);
        }
        throw new Error(`LLM condense HTTP ${response.status} (retryable)`);
      }
      const data = (await response.json()) as any;
      const raw: string = data.choices?.[0]?.message?.content || "";
      const cand = parseLlmJson(raw);
      const got = charsOf(cand.scenes);
      const dist = Math.abs(got - budgetChars);
      if (!best || dist < best.dist) best = { sc: cand, dist };
      if (got < minChars || got > budgetChars) {
        throw new Error(`AI balas ${got} karakter di luar rentang ${minChars}-${budgetChars} - wajib hitung ulang`);
      }
      parsed = cand;
      break;
    } catch (e: any) {
      lastErr = e.message || String(e);
      console.error(`[condense] percobaan ${attempt} gagal: ${lastErr.slice(0, 150)}`);
      if (attempt < 3) await new Promise((ok) => setTimeout(ok, waits[attempt - 1]));
    }
  }
  if (!parsed) {
    if (best) {
      console.log(`[condense] PERINGATAN: 3x di luar rentang - pakai jawaban terdekat (selisih ${best.dist} karakter)`);
      parsed = best.sc;
    } else {
      throw new Error(`LLM condense gagal 3x: ${lastErr.slice(0, 200)}`);
    }
  }
  const out = (parsed.scenes || []).filter((s: any) => String(s.narration_text || "").trim().length > 0);
  if (!out.length) throw new Error("LLM menghasilkan 0 scene");

  await fs.mkdir(path.dirname(path.resolve(condensedPath)), { recursive: true });
  await fs.writeFile(
    path.resolve(condensedPath),
    JSON.stringify({ videoFile: manifest.videoFile, scenes: out }, null, 2)
  );
  const totalChars = out.map((s: any) => String(s.narration_text).length).reduce((a: number, b: number) => a + b, 0);
  console.log(`[condense] ${out.length}/${scenes.length} scene, ${totalChars}/${budgetChars} chars -> ${condensedPath}`);
}

// Hanya jalan sebagai CLI (boleh diimpor untuk unit test parseLlmJson).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`[condense] ERROR: ${e.message}`);
    process.exit(1);
  });
}
