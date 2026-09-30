import { config } from "dotenv";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

config();

export interface SceneOutput {
  id: string;
  start_sec: number;
  end_sec: number;
  description: string;
  narration_text: string;
  /** Posisi horizontal pusat karakter utama, 0-100 (0=tepi kiri, 100=tepi kanan). */
  subject_x_pct?: number;
}

export interface VlmResponse {
  scenes: SceneOutput[];
}

export function parseVlmJson(raw: string): VlmResponse {
  try { return JSON.parse(raw) as VlmResponse; } catch {}
  const codeBlockMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) { try { return JSON.parse(codeBlockMatch[1]) as VlmResponse; } catch {} }
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(raw.slice(firstBrace, lastBrace + 1)) as VlmResponse; } catch {}
  }
  return { scenes: [] };
}

const LANGUAGE_MAP: Record<string, { name: string; example: string }> = {
  Indonesian: { name: "Indonesia", example: "Indonesian sehari-hari" },
  English: { name: "Inggris", example: "casual everyday English" },
  Japanese: { name: "Jepang", example: "日本語のカジュアルな話し言葉" },
  Korean: { name: "Korea", example: "한국어 캐주얼한 말투" },
  Mandarin: { name: "Mandarin", example: "普通话日常口语" },
  Arabic: { name: "Arab", example: "العربية العامية" },
  Hindi: { name: "Hindi", example: "हिंदी बोलचीत" },
  Spanish: { name: "Spanyol", example: "español cotidiano" },
  French: { name: "Prancis", example: "français familier" },
  German: { name: "Jerman", example: "umgangssprachliches Deutsch" },
  Portuguese: { name: "Portugis", example: "português do dia a dia" },
  Russian: { name: "Rusia", example: "разговорный русский" },
  Thai: { name: "Thai", example: "ภาษาไทยพูดทั่วไป" },
  Vietnamese: { name: "Vietnam", example: "tiếng Việt giao tiếp hàng ngày" },
  Turkish: { name: "Turki", example: "günlük Türkçe" },
  Dutch: { name: "Belanda", example: "informeel Nederlands" },
  Polish: { name: "Polandia", example: "potoczny polski" },
  Italian: { name: "Italia", example: "italiano colloquiale" },
  Swedish: { name: "Swedia", example: "vardagligt svenska" },
  Ukrainian: { name: "Ukraina", example: "розмовна українська" },
};

function loadStylePrompt(language: string): string {
  const lang = LANGUAGE_MAP[language] || LANGUAGE_MAP.Indonesian;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mdPath = path.join(here, "..", "prompts", "narration_prompt.md");
  let base: string;
  try {
    base = fs.readFileSync(mdPath, "utf8");
  } catch {
    base = `PERAN
Kamu adalah storyteller video short ${lang.name} yang tenang, jelas, dan mengalir seperti narator dokumenter ringan. Narasi harus enak dibacakan sebagai voice-over TikTok/YouTube Shorts.

PRIORITAS UTAMA
- Akurasi audiovisual selalu lebih penting daripada komedi atau gaya bahasa.
- Gunakan hanya tokoh, aksi, lokasi, dialog, dan hubungan sebab-akibat yang didukung video, audio, atau transcript pendamping.
- Jangan mengarang kejadian untuk membuat cerita lebih lucu. Jika detail tidak jelas, gunakan deskripsi netral.
- Jaga kesinambungan dengan konteks sebelumnya dan jangan mengulang informasi yang sama.

GAYA NARASI
- Gunakan Bahasa ${lang.name} sehari-hari yang kasual, cepat, jelas, dan tidak kaku.
- Minim slang: jangan menumpuk partikel slang di setiap kalimat. Sesekali saja untuk penekanan.
- Fokus pada aksi, konflik, reaksi karakter, dan bagian paling menarik; lewati detail yang membosankan.
- Sisipkan komentar lucu, heran, atau sarkas ringan hanya jika cocok dengan kejadian.
- Boleh memakai satu dialog langsung pendek sebagai penutup bila maknanya jelas dari konteks.
- Jangan memakai bahasa formal, gaya berita, clickbait palsu, makian berat, atau humor yang menutupi jalan cerita.
- Jangan membuka jawaban dengan kalimat meta seperti "Tentu", "Berikut hasilnya", atau "Narasi:".

STRUKTUR
- Awali momen pertama dengan hook berupa pertanyaan langsung yang masuk ke inti cerita.
- Ceritakan kronologis: masa lalu → konflik → usaha/penyamaran → klimaks → pengakuan.
- Tekankan bagian absurd atau klimaks tanpa melebih-lebihkan fakta.
- Tutup dengan punchline: putar makna satu kata kunci dari cerita menjadi kejutan.

FORMAT VOICE-OVER
- Setiap narration_text terdiri dari 1-2 kalimat ringkas.
- Kalimat harus mudah diucapkan, tidak kepanjangan, dan tetap bisa dipahami tanpa membaca description.
- description bersifat faktual dan konkret; narration_text bersifat kasual dan menghibur.`;
  }
  // Replace hardcoded Indonesian references with selected language
  // IMPORTANT: Long/specific patterns FIRST, then short ones
  return base
    .replace(/Bahasa Indonesia sehari-hari yang kasual, cepat, jelas, dan tidak kaku/g, lang.example)
    .replace(/Bahasa Indonesia/g, `Bahasa ${lang.name}`)
    .replace(/ Indonesia /g, ` ${lang.name} `)
    .replace(/Indonesia$/g, lang.name);
}

// HARDCODE — penentuan menit & part (jangan pindah ke MD)
const DURATION_PROMPT_TEMPLATE = `PENENTUAN DURASI (HARDCODE)
Kamu adalah pembuat cerita yang bisa menentukan berapa menit {{MINUTES}} dan berapa part {{PARTS}} untuk video short. Atur total durasi agar pas dengan target: {{MINUTES}} menit per part, total {{PARTS}} part. Bagi cerita secara proporsional.`;

function getDurationPrompt(): string {
  const minutes = process.env.MINUTES_PER_PART || process.env.MINUTES || "2";
  const parts = process.env.PARTS || "0";
  return DURATION_PROMPT_TEMPLATE.replaceAll("{{MINUTES}}", minutes).replaceAll("{{PARTS}}", parts);
}

export const STORYTELLER_SYSTEM_INSTRUCTION = `${loadStylePrompt(process.env.LANGUAGE || "Indonesian")}\n\n${getDurationPrompt()}`;

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "http://localhost:20128/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

export async function analyzeChunkWithR9Video(
  videoPath: string,
  chunkStartSec: number,
  chunkEndSec: number,
  modelName: string = "ag/gemini-3.6-flash-high",
  transcript?: string,
  previousContext?: string,
  isFirstChunk: boolean = true
): Promise<VlmResponse> {
  const chunkDuration = chunkEndSec - chunkStartSec;
  if (chunkDuration <= 0) return { scenes: [] };

  const tmpFile = path.join(os.tmpdir(), `r9_chunk_${Date.now()}_${Math.floor(Math.random() * 1e6)}.mp4`);
  try {
    execSync(`ffmpeg -y -ss ${chunkStartSec.toFixed(3)} -t ${chunkDuration.toFixed(3)} -i "${videoPath}" -c copy "${tmpFile}"`, { stdio: "pipe" });
  } catch (e: any) {
    return { scenes: [] };
  }

  try {
    const buf = fs.readFileSync(tmpFile);
    const b64 = buf.toString("base64");
    
    const transcriptContext = transcript?.trim() ? `\n\nBerikut adalah transkrip audio dari bagian video ini:\n${transcript.trim()}` : "";
    const previousContextBlock = previousContext?.trim() ? `\n\nKONTEKS SEBELUMNYA - lanjutkan cerita dengan adegan BARU, jangan ulangi:\n${previousContext.trim()}` : "";

    const prompt = `Analisis video MP4 ini yang menampilkan rentang waktu ${chunkStartSec}s - ${chunkEndSec}s (klip dari video penuh).
Tugas:
1. Pilih 1-3 momen penting yang benar-benar terjadi dan layak masuk rangkaian cerita.
2. Setiap scene idealnya 3-8 detik.
3. description harus menyebut aksi visual konkret yang terlihat di video.
4. narration_text harus menjadi naskah voice-over final sesuai persona system instruction.
${isFirstChunk ? `7. Scene pertama video (klip ini mulai dari detik 0) BOLEH dibuka dengan hook premis langsung.` : `7. Klip ini BUKAN awal video — JANGAN buka dengan hook/pertanyaan/pembuka. Langsung lanjutkan kronologi dari konteks sebelumnya.`}
5. start_sec dan end_sec adalah detik GLOBAL dari awal video penuh (bukan offset klip) - hitung dari penanda waktu klip + ${chunkStartSec}.
6. Untuk SETIAP scene, perkirakan subject_x_pct: posisi horizontal PUSAT karakter/tokoh utama dalam frame, angka 0-100 (0=tepi kiri, 100=tepi kanan, 50=tengah). Ikuti tokoh yang paling menonjol/penting di scene itu. Jika tidak ada tokoh yang jelas, pakai 50.
${previousContextBlock}${transcriptContext}
Balas JSON SAJA (format contoh - JANGAN tiru teksnya):
{"scenes":[{"start_sec":1,"end_sec":3,"description":"aksi visual konkret","narration_text":"narasi voice-over final","subject_x_pct":42}]}`;

    const reqBody = JSON.stringify({
      model: modelName,
      stream: false,
      messages: [
        { role: "system", content: STORYTELLER_SYSTEM_INSTRUCTION },
        { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:video/mp4;base64,${b64}` } }] }
      ],
      max_tokens: 2048
    });

    // Retry otomatis: network gagal/timeout, HTTP 429, 5xx. Langsung gagal untuk 4xx lain.
    const waits = [10_000, 30_000, 60_000];
    let response: Response | null = null;
    let lastErr = "";
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: reqBody,
          signal: AbortSignal.timeout(600_000),
        });
        if (response.ok) break;
        if (response.status !== 429 && response.status < 500) break;
        lastErr = `HTTP ${response.status}`;
        console.error(`[VLM] chunk ${chunkStartSec}s-${chunkEndSec}s percobaan ${attempt} gagal (${lastErr}), retry...`);
      } catch (e: any) {
        response = null;
        lastErr = e.cause?.code || e.message || String(e);
        console.error(`[VLM] chunk ${chunkStartSec}s-${chunkEndSec}s percobaan ${attempt} gagal (${lastErr}), retry...`);
      }
      if (attempt <= 3) await new Promise((ok) => setTimeout(ok, waits[attempt - 1]));
    }

    if (!response || !response.ok) {
      const errBody = response ? await response.text().catch(() => "") : "";
      console.error(`[VLM] chunk ${chunkStartSec}s-${chunkEndSec}s GAGAL setelah 4x (${lastErr}): ${errBody.slice(0, 200)}`);
      return { scenes: [] };
    }
    const data = await response.json() as any;
    const rawText = data.choices?.[0]?.message?.content || "";
    if (!rawText) {
      console.error(`[VLM] chunk ${chunkStartSec}s-${chunkEndSec}s: respons kosong`);
      return { scenes: [] };
    }

    const parsed = parseVlmJson(rawText);
    if (!parsed.scenes?.length) return { scenes: [] };

    const scenes: Array<SceneOutput & { startSecGlobal: number; endSecGlobal: number }> = [];
    for (const s of parsed.scenes) {
      const start = Math.max(chunkStartSec, Number(s.start_sec) || chunkStartSec);
      const end = Math.min(chunkEndSec, Math.max(start + 1, Number(s.end_sec) || chunkEndSec));
      const text = String(s.narration_text || "").trim();
      if (!text || text === "Narasi menarik" || text === "Y" || text === "X") continue;
      const xRaw = Number((s as any).subject_x_pct);
      const subjectX = Number.isFinite(xRaw) ? Math.min(100, Math.max(0, xRaw)) : undefined;
      scenes.push({ ...s, startSecGlobal: start, endSecGlobal: end, subject_x_pct: subjectX });
    }
    return { scenes };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}
