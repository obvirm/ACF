/**
 * Analysis-only wrapper untuk UI Studio.
 * Menjalankan stage 1&2 (VLM -> manifest) TANPA render FFmpeg.
 * Menghemat waktu: render final baru dilakukan setelah TTS selesai.
 *
 * Usage: node node_modules/tsx/dist/cli.mjs server/analyze.ts <video> <outDir> [model]
 */
import { runAnalysisPipeline } from "../analyzer.js";

const [videoPath, outDir, model] = process.argv.slice(2);
if (!videoPath || !outDir) {
  console.error("usage: analyze.ts <video> <outDir> [model]");
  process.exit(1);
}

const manifestPath = await runAnalysisPipeline({
  videoPath,
  outputDir: outDir,
  ollamaModel: model || "gemini/gemini-3.6-flash",
});

console.log("[analyze] manifest: " + manifestPath);
