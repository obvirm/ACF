import { config } from 'dotenv';
config();
import { parseArgs } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { runAnalysisPipeline } from './analyzer.js';
import { renderShortVideo } from './renderer/renderer.js';

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      video: {
        type: 'string',
        short: 'v'
      },
      out: {
        type: 'string',
        short: 'o'
      },
      model: {
        type: 'string',
        short: 'm',
        default: process.env.MODEL_NAME || 'ag/gemini-3.6-flash-high'
      },
      'only-render': {
        type: 'string' // Pass a manifest path to skip analysis
      },
      audio: {
        type: 'string' // Optional narration-only track for render
      },
      'scene-durations': {
        type: 'string' // Optional per-scene narration durations JSON
      },
      'camera-plan': {
        type: 'string' // Optional camera plan (director positions) JSON
      },
      stretch: {
        type: 'string' // 0..1 — mode lonjong: 0 = rasio asli, 1 = stretch penuh 1080x1920
      },
      hzoom: {
        type: 'string' // >1 — potong sisi kiri-kanan agar karakter terlihat lebih lebar (mis. 1.15)
      },
      bgm: {
        type: 'string' // Optional BGM track (flac/mp3/wav) untuk di-mix dengan narasi
      },
      'speed-min': {
        type: 'string' // Batas lambat tempo mengikuti narasi, default 0.5 (freeze di bawahnya)
      },
      'speed-max': {
        type: 'string' // Batas cepat tempo mengikuti narasi, default 2 (potong di atasnya)
      },
      'color-grade': {
        type: 'string' // Preset grading: normal|cinematic|warm|cool|vivid|vintage|dramatic|random
      },
      'mirror': {
        type: 'boolean' // Flip horizontal sumber (anti Content ID visual); caption/overlay tetap normal
      },
      'grain': {
        type: 'boolean' // Noise film grain di akhir chain (memecah fingerprint CGI halus)
      },
      'scene-zoom': {
        type: 'boolean' // Zoom acak per scene (1.0-1.3x dari zoom dasar)
      },
      'rotate': {
        type: 'boolean' // Rotasi 0.5 derajat + overscan 4% (geometri anti-fingerprint)
      },
      'lens-warp': {
        type: 'boolean' // Distorsi lensa barrel tipis k1=-0.03 (geometri non-linear anti-fingerprint)
      }
    },
    allowPositionals: true
  });
  const numOrUndef = (v: unknown): number | undefined => {
    const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  if (values['only-render']) {
    const manifestPath = path.resolve(values['only-render']);
    const manifestDir = path.dirname(manifestPath);

    // Determine output file path
    let outputMp4: string;
    if (values.out) {
      const outPath = path.resolve(values.out);
      // Check if out is a directory
      try {
        const stat = await fs.stat(outPath);
        if (stat.isDirectory()) {
          outputMp4 = path.join(outPath, 'final_short.mp4');
        } else {
          outputMp4 = outPath;
        }
      } catch {
        // Path doesn't exist, treat as file if it has an extension, else directory
        const ext = path.extname(outPath);
        if (ext) {
          outputMp4 = outPath;
        } else {
          await fs.mkdir(outPath, { recursive: true });
          outputMp4 = path.join(outPath, 'final_short.mp4');
        }
      }
    } else {
      outputMp4 = path.join(manifestDir, 'final_short.mp4');
    }

    console.log(`[Mode] Skipping analysis, rendering from existing manifest: ${manifestPath}`);

    // Resolve video file path
    let videoPath = values.video ? path.resolve(values.video) : null;
    if (!videoPath) {
      const manifestData = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestData);
      const possiblePaths = [
        path.resolve('data/input', manifest.videoFile),
        path.resolve(manifestDir, '..', 'input', manifest.videoFile),
        path.resolve(manifestDir, manifest.videoFile),
        manifest.videoFile
      ];
      for (const p of possiblePaths) {
        try {
          await fs.access(p);
          videoPath = p;
          break;
        } catch {}
      }
      if (!videoPath) {
        console.error('Could not find video file. Please provide --video <path>');
        process.exit(1);
      }
    }
    await renderShortVideo(
      manifestPath,
      outputMp4,
      videoPath,
      values.audio ? path.resolve(values.audio) : undefined,
      values['scene-durations'] ? path.resolve(values['scene-durations']) : undefined,
      values['camera-plan'] ? path.resolve(values['camera-plan']) : undefined,
      values.stretch !== undefined ? Number(values.stretch) : undefined,
      values.hzoom !== undefined ? Number(values.hzoom) : undefined,
      values.bgm ? path.resolve(values.bgm) : undefined,
      numOrUndef(values['speed-min']),
      numOrUndef(values['speed-max']),
      values['color-grade'],
      values.mirror === true,
      values.grain === true,
      values['scene-zoom'] === true,
      values.rotate === true,
      values['lens-warp'] === true
    );
    return;
  }

  if (!values.video) {
    console.error('Usage: npx tsx src/index.ts --video <path-to-video.mp4> [--out <dir>] [--model gemini/gemini-3.6-flash]');
    process.exit(1);
  }

  const videoPath = path.resolve(values.video);
  // Default output dir is a folder with the same name as the video
  const defaultOutDir = path.join('data/output', path.basename(videoPath, path.extname(videoPath)));
  const outputDir = values.out ? path.resolve(values.out) : path.resolve(defaultOutDir);

  try {
    console.log(`\n==============================================`);
    console.log(`🎬 MOVIE2SHORT - AI VLM SHORT GENERATOR`);
    console.log(`==============================================\n`);

    // Stage 1 & 2: Analysis & Data generation
    const manifestPath = await runAnalysisPipeline({
      videoPath,
      outputDir,
      ollamaModel: values.model
    });

    // Stage 4: Render Visuals
    console.log(`\n==============================================`);
    console.log(`🎥 RENDERING VISUALS VIA FFMPEG`);
    console.log(`==============================================\n`);
    const outputMp4 = path.join(outputDir, 'output_short.mp4');
    await renderShortVideo(
      manifestPath,
      outputMp4,
      videoPath,
      values.audio ? path.resolve(values.audio) : undefined,
      values['scene-durations'] ? path.resolve(values['scene-durations']) : undefined,
      values['camera-plan'] ? path.resolve(values['camera-plan']) : undefined,
      values.stretch !== undefined ? Number(values.stretch) : undefined,
      values.hzoom !== undefined ? Number(values.hzoom) : undefined,
      values.bgm ? path.resolve(values.bgm) : undefined,
      numOrUndef(values['speed-min']),
      numOrUndef(values['speed-max']),
      values['color-grade'],
      values.mirror === true,
      values.grain === true,
      values['scene-zoom'] === true,
      values.rotate === true,
      values['lens-warp'] === true
    );
    console.log(`- Final Video:  ${outputMp4}`);
    console.log(`- Narration:    ${path.join(outputDir, 'narasi.txt')}`);
    console.log(`- Data Config:  ${manifestPath}`);
    if (values.audio) console.log(`- TTS Audio:    ${path.resolve(values.audio)}`);
    console.log(values.audio
      ? `\n(Audio final menggunakan track narasi saja; audio asli tidak dimux.)\n`
      : `\n(Note: berikan --audio <narration.wav> untuk menambahkan track narasi.)\n`);

  } catch (error) {
    console.error('\n❌ Fatal Pipeline Error:', error);
    process.exit(1);
  }
}

main();
