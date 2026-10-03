import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

const execAsync = promisify(exec);

// Preset color grading: transformasi warna piksel asli (eq + colorbalance),
// bukan overlay. Dipakai untuk bedakan visual dari sumber + selera sinematik.
const COLOR_GRADE_FILTERS: Record<string, string> = {
  cinematic: 'eq=contrast=1.10:saturation=0.95:brightness=-0.02,colorbalance=rs=-0.06:bs=0.06:rm=-0.04:bm=0.06:rh=0.05:bh=-0.05',
  warm: 'eq=contrast=1.05:saturation=1.10,colorbalance=rm=0.06:gm=0.02:bm=-0.06:rh=0.07:bh=-0.07',
  cool: 'eq=contrast=1.05:saturation=1.05,colorbalance=rm=-0.06:bm=0.07:rh=-0.06:bh=0.07',
  vivid: 'eq=contrast=1.15:saturation=1.30:brightness=0.02',
  vintage: 'eq=contrast=0.94:saturation=0.75:brightness=0.05:gamma=1.05,colorbalance=rs=0.05:bs=0.04:gh=0.03:bh=-0.05',
  dramatic: 'eq=contrast=1.28:saturation=0.88:brightness=-0.05:gamma=0.95',
};

/**
 * Runs FFmpeg to render the final MP4.
 * Processes each scene individually with zoom+blur filter, then concatenates.
 *
 * @param manifestPath Path to the manifest.json created by analyzer
 * @param outputMp4Path Where to save the final video
 * @param videoPath Path to the source video file
 * @param narrationAudioPath Optional narration-only audio track
 */
export async function renderShortVideo(
  manifestPath: string,
  outputMp4Path: string,
  videoPath: string,
  narrationAudioPath?: string,
  sceneDurationsPath?: string,
  cameraPlanPath?: string,
  stretchRatio?: number,
  hZoomRatio?: number,
  bgmPath?: string,
  speedMin: number = 0.5,
  speedMax: number = 2,
  colorGrade?: string,
  mirror?: boolean,
  grain?: boolean,
  sceneZoom?: boolean,
  rotate?: boolean,
  lensWarp?: boolean,
  texture?: boolean
) {
  const absManifest = path.resolve(manifestPath);
  const absOutput = path.resolve(outputMp4Path);
  const actualVideoPath = path.resolve(videoPath);
  const actualNarrationPath = narrationAudioPath ? path.resolve(narrationAudioPath) : undefined;
  const actualBgmPath = bgmPath ? path.resolve(bgmPath) : undefined;
  const sceneDurationsData = sceneDurationsPath
    ? JSON.parse(await fs.readFile(path.resolve(sceneDurationsPath), 'utf8'))
    : undefined;
  const sceneDurations = sceneDurationsData?.sceneDurationsSec as number[] | undefined;
  const cameraPlanData = cameraPlanPath
    ? JSON.parse(await fs.readFile(path.resolve(cameraPlanPath), 'utf8'))
    : undefined;
  const cameraPlan: { scene: string; position: string }[] | undefined = cameraPlanData?.plan;

  console.log(`       Video source: ${actualVideoPath}`);
  if (actualNarrationPath) console.log(`       Narration: ${actualNarrationPath}`);
  if (actualBgmPath) console.log(`       BGM: ${actualBgmPath}`);
  const gradeFilter = colorGrade && colorGrade !== 'normal' ? COLOR_GRADE_FILTERS[colorGrade] : undefined;
  if (gradeFilter) console.log(`       Color grading: ${colorGrade}`);
  if (sceneDurations) console.log(`       Per-scene narration durations: ${sceneDurationsPath}`);
  if (cameraPlan) console.log(`       Camera plan (director): ${cameraPlanPath} (${cameraPlan.length} scene)`);

  // Read manifest
  const manifestData = await fs.readFile(absManifest, 'utf8');
  const inputProps = JSON.parse(manifestData);
  const scenes = inputProps.scenes || [];

  if (scenes.length === 0) {
    throw new Error('No scenes found in manifest');
  }

  // Target Resolution: 1080x1920 (9:16)
  const W = 1080;
  const H = 1920;

  // Filter: background blur + foreground. Mode LONJONG (stretchRatio 0..1):
  // fg di-stretch vertikal — 0 = rasio asli (band 1080x608), 1 = penuh
  // 1080x1920 (karakter memanjang maksimal). Tanpa stretch = zoom 1.15 crop
  // tengah (perilaku commit, "aman"). Camera plan menggeser posisi overlay.
  const useStretch = typeof stretchRatio === 'number' && stretchRatio >= 0;
  const baseZoom = 1.15;
  const stretchZoom = typeof hZoomRatio === 'number' && hZoomRatio > 1 ? hZoomRatio : 1;
  const foregroundZoom = useStretch
    ? baseZoom
    : typeof hZoomRatio === 'number' && hZoomRatio > 0 ? hZoomRatio : baseZoom;
  // Pan must stay inside the horizontal crop created by the foreground zoom.
  // At 1.15x, the 1080px foreground becomes 1242px wide, so only 81px
  // of movement is available on either side of the centered position.
  const foregroundWidth = Math.round(W * foregroundZoom);
  const cameraPanMax = Math.max(0, Math.floor((foregroundWidth - W) / 2));
  let filterComplex: string;
  let zoomTemplate: string | undefined;
  if (useStretch) {
    const fgH = Math.round(608 + (1920 - 608) * Math.min(1, Math.max(0, stretchRatio)));
    const fgW = Math.round(W * stretchZoom);
    filterComplex = `[0:v]split=2[bg_src][fg_src];[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=50[bga];[bga]eq=brightness=-0.3[bg];[fg_src]scale=${fgW}:${fgH},crop=${W}:${fgH}[fg];[bg][fg]overlay=0:${Math.round((H - fgH) / 2)}:format=auto[outv]`.replace(/\s+/g, '');
    console.log(`       Stretch (lonjong) mode: ratio=${stretchRatio} hZoom=${stretchZoom} -> fg ${fgW}x${fgH}`);
  } else {
    zoomTemplate = `[0:v]split=2[bg_src][fg_src];[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=50[bga];[bga]eq=brightness=-0.3[bg];[fg_src]scale=${W}:${H}:force_original_aspect_ratio=decrease,scale=iw*@ZOOM@:ih*@ZOOM@[fg];[bg][fg]overlay=x:y:format=auto[outv]`.replace(/\s+/g, '');
    filterComplex = zoomTemplate.split('@ZOOM@').join(String(foregroundZoom));
    if (foregroundZoom !== baseZoom) console.log(`       Zoom (lonjong off): ${foregroundZoom}x`);
  }
  if (mirror) {
    filterComplex = filterComplex.replace('[0:v]split=2', '[0:v]hflip[mr];[mr]split=2');
    console.log('       Mirror: hflip ON');
  }
  if (grain) console.log('       Grain: noise ON (alls=7)');
  if (sceneZoom) console.log('       SceneZoom: random per scene (1.0-1.3x)');
  if (rotate) console.log('       Rotate: 0.5deg + overscan ON');
  if (lensWarp) console.log('       LensWarp: barrel k1=-0.03 ON');
  if (texture) console.log('       Texture: dynamic overlay ON (scroll 17/11 px, aa=0.04)');

  // Temp directory for scene clips
  const tempDir = path.join(path.dirname(absOutput), '_temp_scenes');
  await fs.mkdir(tempDir, { recursive: true });

  const sceneClips: string[] = [];


  console.log(`[1/3] Rendering ${scenes.length} scenes individually...`);

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const startSec = scene.start_sec;
    const endSec = scene.end_sec;

    // Skip invalid scenes
    if (endSec <= startSec || endSec - startSec < 0.5) {
      console.warn(`       Scene ${i + 1} skipped: invalid duration (${startSec}s-${endSec}s)`);
      continue;
    }

    // Narration is the master timeline: every visual clip has exactly the
    // natural narration duration. Tempo mengikuti narasi (diperintah AI via
    // durasi): speed = take/D clamp [speedMin, speedMax]. Di luar batas:
    // kepanjangan dipotong, kependekan di-freeze frame terakhir.
    const sourceDuration = endSec - startSec;
    const duration = sceneDurations && sceneDurations[i] !== undefined
      ? Math.max(0.5, sceneDurations[i])
      : sourceDuration;
    const ideal = sourceDuration / duration;
    const speed = Math.min(speedMax, Math.max(speedMin, ideal));
    let take: number;
    let extraVisualDuration: number;
    if (ideal > speedMax) {
      take = duration * speedMax;
      extraVisualDuration = 0;
    } else if (ideal < speedMin) {
      take = sourceDuration;
      extraVisualDuration = Math.max(0, duration - sourceDuration / speedMin);
    } else {
      take = Math.min(sourceDuration, duration * speed);
      extraVisualDuration = Math.max(0, duration - take / speed);
    }
    // If narration is shorter, center the crop inside the annotated scene so
    // the main action is less likely to be lost by always taking its beginning.
    const visualStart = take < sourceDuration
      ? startSec + (sourceDuration - take) / 2
      : startSec;
    const visualInputDuration = take;
    // Director: posisi overlay per scene (HANYA mode zoom — mode stretch tidak geser).
    // Prioritas: camera plan manual > subject_x_pct dari VLM > tengah.
    let overlayX = "(W-w)/2";
    const overlayY = "(H-h)/2";
    if (cameraPlan && !useStretch) {
      const entry = cameraPlan.find(p => p.scene === scene.id);
      const rawPos = entry?.position;
      const pos = mirror && rawPos === 'left' ? 'right'
        : mirror && rawPos === 'right' ? 'left'
          : rawPos;
      // `left`/`right` select the corresponding edge of the zoom crop.
      // The clamp is essential: shifting by the portrait canvas width would
      // expose empty space and make the foreground appear pushed off-screen.
      const shift = pos === "left"
        ? cameraPanMax
        : pos === "right"
          ? -cameraPanMax
          : 0;
      if (shift !== 0) overlayX = `(W-w)/2+(${shift})`;
      console.log(`       ${scene.id}: director=${pos} shift=${shift} (max=${cameraPanMax})`);
    } else if (!useStretch && typeof scene.subject_x_pct === 'number' && Number.isFinite(scene.subject_x_pct)) {
      // Continuous director: map VLM's subject x-position (0-100%) onto the
      // available pan range. Subject at frame edge -> shift to that edge of
      // the zoom crop so it moves toward center; small offsets stay centered
      // (dead zone) so adjacent scenes never jitter left-right-left.
      const sx = mirror ? 100 - scene.subject_x_pct : scene.subject_x_pct;
      const dx = Math.min(100, Math.max(0, sx)) - 50;
      const deadZonePct = 5;
      const shift = Math.abs(dx) < deadZonePct ? 0 : -Math.round((dx / 50) * cameraPanMax);
      if (shift !== 0) {
        overlayX = `(W-w)/2+(${shift})`;
        console.log(`       ${scene.id}: subject_x=${sx.toFixed(1)}% shift=${shift} (max=${cameraPanMax})`);
      }
    }

    let suffix = '';
    if (Math.abs(speed - 1) > 0.001) suffix += `,setpts=PTS/${speed.toFixed(4)}`;
    if (extraVisualDuration > 0.01) suffix += `,tpad=stop_mode=clone:stop_duration=${extraVisualDuration.toFixed(3)}`;
    let sceneFilterComplex = filterComplex;
    if (sceneZoom && zoomTemplate) {
      const z = (foregroundZoom * (1 + Math.random() * 0.3)).toFixed(3);
      sceneFilterComplex = zoomTemplate.split('@ZOOM@').join(z);
      if (mirror) sceneFilterComplex = sceneFilterComplex.replace('[0:v]split=2', '[0:v]hflip[mr];[mr]split=2');
      console.log(`\n       ${scene.id}: sceneZoom ${z}x`);
    }
    if (suffix) sceneFilterComplex = sceneFilterComplex.replace('[outv]', `${suffix}[outv]`);
    sceneFilterComplex = sceneFilterComplex
      .replace('overlay=x:y', `overlay=${overlayX}:${overlayY}`);
    if (gradeFilter) sceneFilterComplex = sceneFilterComplex.replace('[outv]', `,${gradeFilter}[outv]`);
    if (rotate) sceneFilterComplex = sceneFilterComplex.replace('[outv]', ',scale=iw*1.04:ih*1.04,rotate=0.5*PI/180:ow=1080:oh=1920[outv]');
    if (lensWarp) sceneFilterComplex = sceneFilterComplex.replace('[outv]', ',lenscorrection=cx=0.5:cy=0.5:k1=-0.03:k2=0[outv]');
    if (texture) {
      sceneFilterComplex = sceneFilterComplex
        .replace('split=2[bg_src][fg_src]', 'split=3[bg_src][fg_src][tx_src]')
        .replace('[outv]', "[m0];[tx_src]scale=270:480,noise=alls=40:allf=t+u,gblur=sigma=6,format=rgba,colorchannelmixer=aa=0.04,scale=1296:2304[tx];[m0][tx]overlay=x='-mod(t*17,216)':y='-mod(t*11,384)':format=auto[outv]");
    }
    if (grain) sceneFilterComplex = sceneFilterComplex.replace('[outv]', ',noise=alls=7:allf=t+u[outv]');
    if (Math.abs(speed - 1) > 0.001) console.log(`       ${scene.id}: tempo ${speed.toFixed(2)}x (visual ${take.toFixed(1)}s -> narasi ${duration.toFixed(1)}s)`);
    const clipPath = path.join(tempDir, `scene_${String(i).padStart(4, '0')}.mp4`);

    const cmd = `ffmpeg -y -ss ${visualStart.toFixed(3)} -t ${visualInputDuration.toFixed(3)} -i "${actualVideoPath}" -filter_complex "${sceneFilterComplex}" -map "[outv]" -an -t ${duration.toFixed(3)} -c:v libx264 -preset fast -crf 23 "${clipPath}"`;

    try {
      await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10, timeout: 300000 });
      sceneClips.push(clipPath);
      process.stdout.write(`\r       Scene ${i + 1}/${scenes.length} done (${startSec}s-${endSec}s)`);
    } catch (e: any) {
      console.warn(`\n       Scene ${i + 1} failed: ${e.message.substring(0, 50)}`);
    }
  }

  console.log(`\n[2/3] Concatenating ${sceneClips.length} scenes...`);

  if (sceneClips.length === 0) {
    throw new Error('No scenes were rendered successfully');
  }

  // Create concat list file
  const concatListPath = path.join(tempDir, 'concat.txt');
  const concatContent = sceneClips.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
  await fs.writeFile(concatListPath, concatContent);

  // Concatenate all scenes into one silent visual track.
  const silentVideoPath = actualNarrationPath
    ? path.join(tempDir, 'visual_only.mp4')
    : absOutput;
  const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${silentVideoPath}"`;

  try {
    await execAsync(concatCmd, { maxBuffer: 1024 * 1024 * 10, timeout: 120000 });
  } catch (e: any) {
    throw new Error(`Concat failed: ${e.message}`);
  }

  // The source clips are already silent. Map only the OmniVoice input as audio,
  // so original video audio and music can never enter the final output.
  // Jika BGM ada, mix dengan narasi (BGM di-loop, volume rendah).
  let bgmAvailable = false;
  if (actualBgmPath) {
    try { await fs.access(actualBgmPath); bgmAvailable = true; } catch { bgmAvailable = false; }
  }
  if (actualNarrationPath) {
    await fs.access(actualNarrationPath);
    if (bgmAvailable) {
      const muxCmd = `ffmpeg -y -i "${silentVideoPath}" -i "${actualNarrationPath}" -stream_loop -1 -i "${actualBgmPath}" -filter_complex "[1:a]aformat=channel_layouts=stereo[voice];[2:a]aformat=channel_layouts=stereo,volume=0.12,aresample=48000[bgm];[voice][bgm]amix=inputs=2:duration=shortest:dropout_transition=0:normalize=0[mix]" -map 0:v:0 -map "[mix]" -c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 -shortest -movflags +faststart "${absOutput}"`;
      try {
        await execAsync(muxCmd, { maxBuffer: 1024 * 1024 * 10, timeout: 120000 });
      } catch (e: any) {
        throw new Error(`Narration+BGM mux failed: ${e.message}`);
      }
    } else {
      const muxCmd = `ffmpeg -y -i "${silentVideoPath}" -i "${actualNarrationPath}" -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -ar 48000 -ac 1 -shortest -movflags +faststart "${absOutput}"`;
      try {
        await execAsync(muxCmd, { maxBuffer: 1024 * 1024 * 10, timeout: 120000 });
      } catch (e: any) {
        throw new Error(`Narration mux failed: ${e.message}`);
      }
    }
  }

  // Cleanup temp files
  for (const clip of sceneClips) {
    try { await fs.unlink(clip); } catch {}
  }
  try { await fs.unlink(concatListPath); } catch {}
  if (actualNarrationPath) {
    try { await fs.unlink(silentVideoPath); } catch {}
  }
  try { await fs.rmdir(tempDir); } catch {}

  console.log(`[3/3] Done!`);
  console.log(`       Output: ${absOutput}`);
  console.log(`       Scenes: ${sceneClips.length}`);
}
