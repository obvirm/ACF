import fs from "fs/promises";
import path from "path";
import { Ollama } from "ollama";

const ollama = new Ollama();

interface Scene { id: string; start_sec: number; end_sec: number; description: string; narration_text: string; }
interface Segment { start: number; end: number; text: string; }

const REF_EXAMPLES = [
  `Jadi, di suatu hari yang cerah, seperti biasa, SpongeBob sangat bersemangat untuk bekerja, wak.`,
  `Nah, tapi di hari yang tenang ini, tiba-tiba Tuan Krab datang dan bilang kalau dia memecat SpongeBob.`,
  `Panik dong, SpongeBob. Dia pun langsung pulang dengan wajah lesu, coy.`,
  `SpongeBob pun kembali bersemangat untuk mencari pekerjaan baru.`,
  `Kemudian, dia pergi ke restoran hotdog untuk melamar menjadi koki.`,
  `Nah, ternyata setelah ditinggal SpongeBob, Krusty Krab jadi kacau balau.`
];

export async function synthesizeNarration(manifestPath: string, outputDir: string, transcript?: string, extraPrompt?: string): Promise<string> {
  console.log(`[Stage 2] Starting...`);

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const scenes: Scene[] = manifest.scenes || [];
  if (scenes.length === 0) return manifestPath;

  let segments: Segment[] = [];
  try { segments = JSON.parse(await fs.readFile(path.join(outputDir, "transcript_timestamps.json"), "utf8")); } catch {}

  // Buat context untuk mengurangi repetisi - kumpulin transcript unik
  const allTranscripts = new Set<string>();
  segments.forEach(s => allTranscripts.add(s.text));
  const uniqueTranscripts = Array.from(allTranscripts).filter(t => t.length > 5);

  const improved: Scene[] = [];
  let prevNarration = "";
  let nahCount = 0;

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    let sceneText = "";
    if (segments.length > 0) {
      const overlap = segments.filter(seg => seg.start < s.end_sec && seg.end > s.start_sec);
      if (overlap.length > 0) sceneText = overlap.map(seg => seg.text).join(" ");
    } else if (transcript && transcript.length > 0) {
      const totalDur = Math.max(...scenes.map(x => x.end_sec));
      const ratio = s.start_sec / totalDur;
      const pos = Math.floor(ratio * transcript.length);
      sceneText = transcript.substring(Math.max(0, pos - 50), Math.min(transcript.length, pos + 200));
    }

    if (!sceneText || sceneText.length < 3) {
      improved.push(s);
      continue;
    }

    // Variasi prompt biar gak repetitive
    const prompt = `Transcript dialog: "${sceneText}"

Buat 1-2 kalimat narasi Bahasa Indonesia dengan gaya storytelling santai.

GAYA (contoh dari referensi):
- "Jadi, di suatu hari yang cerah, seperti biasa, SpongeBob sangat bersemangat untuk bekerja, wak."
- "Nah, tapi di hari yang tenang ini, tiba-tiba Tuan Krab datang dan bilang kalau dia memecat SpongeBob."
- "Panik dong, SpongeBob. Dia pun langsung pulang dengan wajah lesu, coy."
- "Kemudian, dia pergi ke restoran hotdog untuk melamar menjadi koki."

Aturan:
- 1-2 kalimat, ceritakan aksi/kejadian dalam adegan
- Pakai sisipan ringan: wak, coy, dong (secukupnya, jangan berlebihan)
- Transisi natural: Nah, Kemudian, Tapi ternyata
- JANGAN ulangi narasi sebelumnya
- Storytelling deskriptif, bukan berita${extraPrompt?.trim() ? `\n- Ikuti instruksi tambahan: ${extraPrompt.trim()}` : ""}

Narasi:`;

    try {
      const resp = await ollama.chat({
        model: "qwen2.5:3b",
        messages: [{ role: "user", content: prompt }],
        options: { temperature: 0.8, top_p: 0.9 },
      });

      let nar = resp.message.content.trim().replace(/^(Narasi:|Kalimat:|"|')\s*/i, "").replace(/["']$/g, "");
      if (nar.length < 5) nar = s.narration_text;

      // Hitung Nah
      if (nar.toLowerCase().startsWith("nah")) nahCount++;
      else nahCount = Math.max(0, nahCount - 1);

      improved.push({ ...s, narration_text: nar });
      prevNarration = nar;
    } catch {
      improved.push(s);
    }

    if ((i + 1) % 20 === 0 || i === scenes.length - 1) console.log(`  ${i + 1}/${scenes.length}`);
  }

  manifest.scenes = improved;
  await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(outputDir, "narasi.txt"), improved.map(x => `[${x.start_sec}s - ${x.end_sec}s] ${x.narration_text}`).join("\n\n"));
  console.log(`[Stage 2] Done! ${improved.length} scenes.`);
  return path.join(outputDir, "manifest.json");
}
