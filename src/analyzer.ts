import path from "path";
import fs from "fs/promises";
import { analyzeChunkWithR9Video, SceneOutput } from "./analyzer/model.js";
import { extractAudio } from "./analyzer/audioExtractor.js";
import { synthesizeNarration } from "./synthesizer/narrationSynthesizer.js";

export interface PipelineOptions {
  videoPath: string;
  outputDir: string;
  intervalSec?: number;
  ollamaModel?: string; 
}

export async function runAnalysisPipeline(options: PipelineOptions) {
  const { videoPath, outputDir, ollamaModel = "r9/ag/gemini-3.6-flash-high" } = options;
  const actualModel = ollamaModel.replace("r9/", "").replace("gemini/", "");

  console.log("[1/5] Ensuring output directories...");
  await fs.mkdir(outputDir, { recursive: true });
  const tempDir = path.join(outputDir, "temp");
  await fs.mkdir(tempDir, { recursive: true });

  console.log("[2/5] Getting video duration...");
  let totalDuration = 60;
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const { stdout } = await execAsync('ffprobe -v error -show_entries format=duration -of csv=p=0 "' + path.resolve(videoPath) + '"');
    totalDuration = parseFloat(stdout.trim()) || 60;
    console.log("       Duration: " + totalDuration + "s");
  } catch {
    console.log("       Default: " + totalDuration + "s");
  }

  console.log("[3/5] Preparing audio context...");
  let transcript = "";
  const transcriptTextPath = path.join(outputDir, "transcript.txt");
  const transcriptSegmentsPath = path.join(outputDir, "transcript_timestamps.json");

  console.log("       OpenAI Compatible Model akan membaca audio langsung dari MP4; Whisper dilewati.");

  console.log("[4/5] VLM analysis...");
  const allScenes: SceneOutput[] = [];
  const chunkDurationRaw = Number(process.env.CHUNK_DURATION || "40");
  const chunkDuration = chunkDurationRaw > 0 ? chunkDurationRaw : totalDuration;
  let previousNarration = "";

  let transcriptSegments: Array<{ start: number; end: number; text: string }> = [];
  try {
    transcriptSegments = JSON.parse(
      await fs.readFile(path.join(outputDir, "transcript_timestamps.json"), "utf8")
    );
  } catch {}

  for (let cs = 0; cs < totalDuration; cs += chunkDuration) {
    const ce = Math.min(cs + chunkDuration, totalDuration);
    const chunkTranscript = transcriptSegments
      .filter(segment => segment.start < ce && segment.end > cs)
      .map(segment => {
        const localStart = Math.max(0, segment.start - cs).toFixed(2);
        const localEnd = Math.min(ce - cs, segment.end - cs).toFixed(2);
        return `[${localStart}s-${localEnd}s] ${segment.text}`;
      }).join("\n");

    console.log("       Chunk " + cs + "s-" + ce + "s | MP4 audio+visual via OpenAI Compatible");

    const r = await analyzeChunkWithR9Video(videoPath, cs, ce, actualModel, chunkTranscript, previousNarration, cs === 0);

    if (r.scenes.length > 0) {
      const scenesWithGlobalIds = r.scenes.map((scene, index) => ({
        ...scene,
        id: `scene_${allScenes.length + index + 1}`
      }));
      allScenes.push(...scenesWithGlobalIds);
      previousNarration = scenesWithGlobalIds.slice(-3).map(s => `[${s.start_sec}s-${s.end_sec}s] ${s.narration_text}`).join("; ");
    }
  }
  console.log("[5/5] Analysis done. " + allScenes.length + " scenes");

  const stage1Manifest = path.join(outputDir, "manifest_stage1.json");
  await fs.writeFile(stage1Manifest, JSON.stringify({ videoFile: path.basename(videoPath), scenes: allScenes }, null, 2));

  const stage1Narasi = path.join(outputDir, "narasi_stage1.txt");
  await fs.writeFile(stage1Narasi, allScenes.map(s => `[${s.start_sec}s - ${s.end_sec}s] ${s.narration_text}`).join("\n\n"));

  console.log("- Stage 1 manifest: " + stage1Manifest);
  console.log("- Stage 1 narasi: " + stage1Narasi);

  const manifestPath = await synthesizeNarration(stage1Manifest, outputDir, transcript);
  return manifestPath;
}
