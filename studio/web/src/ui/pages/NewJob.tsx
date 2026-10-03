import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { VideoDropzone } from "@/ui/components/VideoDropzone";
import { TemplateGrid } from "@/ui/components/TemplateGrid";
import { getTemplates, runPipeline, uploadVideo, previewFrame, type TemplateMeta } from "@/app/api/client";
import { getOverlayTemplates, saveOverlayTemplate, deleteOverlayTemplate, loadOverlayTemplate, type OverlayTemplate } from "@/app/api/client";
import { useAppStore } from "@/app/stores/appStore";
import { Loader2, AlertCircle, Settings2, Clapperboard, Layers, Mic2, Sparkles, Zap, Scissors, Music, Trash2, Save } from "lucide-react";

export function NewJob() {
  const navigate = useNavigate();
  const { lastVideoPath, setLastVideoPath } = useAppStore();
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [videoPath, setVideoPath] = useState<string | null>(lastVideoPath);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRunningJob, setActiveRunningJob] = useState<string | null>(null);

  const [model, setModel] = useState("ag/gemini-3.6-flash-high");
  const [prompt, setPrompt] = useState("");
  const [chunk, setChunk] = useState(true);
  const [outputMode, setOutputMode] = useState<"one" | "auto" | "manual">("one");
  const [minutesPerPart, setMinutesPerPart] = useState(2);
  const [parts, setParts] = useState(0);
  const [targetMinutes, setTargetMinutes] = useState(3);
  const [stretch, setStretch] = useState<number | undefined>(undefined);
  const [hzoom, setHzoom] = useState<number | undefined>(1.15);
  const [mirror, setMirror] = useState(false);
  const [grain, setGrain] = useState(false);
  const [speedMin, setSpeedMin] = useState<number | undefined>(0.5);
  const [speedMax, setSpeedMax] = useState<number | undefined>(2);
  const parseNum = (v: string): number | undefined => {
    if (v === "") return undefined;
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  };
  const [previewAtSec, setPreviewAtSec] = useState<number | undefined>(12);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const handlePreview = async () => {
    if (!videoPath) { setPreviewError("Upload video dulu"); return; }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const r = await previewFrame({ videoPath, stretch, hzoom, mirror, grain, atSec: previewAtSec });
      setPreviewImg(r.image);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewLoading(false);
    }
  };
  const [caption, setCaption] = useState(true);
  const [template, setTemplate] = useState("loki");
  const [lead, setLead] = useState(5);
  const [tail, setTail] = useState(5);
  const [overlayMode, setOverlayMode] = useState<"none" | "image" | "css">("none");
  const [colorGrade, setColorGrade] = useState<"normal" | "cinematic" | "warm" | "cool" | "vivid" | "vintage" | "dramatic" | "random">("random");
  const [overlayImage, setOverlayImage] = useState<string | null>(null);
  const [overlayImageName, setOverlayImageName] = useState<string | null>(null);
  const [overlayUploading, setOverlayUploading] = useState(false);
  const [overlayHtml, setOverlayHtml] = useState('<div class="frame"></div>\n<div class="top">JUDUL</div>');
  const [overlayCss, setOverlayCss] = useState('.frame { position: absolute; inset: 24px; border: 12px solid #B6FF3B; border-radius: 48px; }\n.top { position: absolute; top: 90px; left: 0; right: 0; text-align: center; font-family: Anton, sans-serif; font-size: 110px; color: #fff; -webkit-text-stroke: 2px #000; }');
  const [voiceRef, setVoiceRef] = useState<string>("");
  const [voiceRefName, setVoiceRefName] = useState<string | null>(null);
  const [voiceRefUploading, setVoiceRefUploading] = useState(false);
  const [language, setLanguage] = useState("Indonesian");
  const [whisperQuality, setWhisperQuality] = useState<"tiny" | "base" | "small" | "medium">("medium");
  const [ttsModel, setTtsModel] = useState<string>("higgs-tts-q4");
  const [bgmPath, setBgmPath] = useState<string | null>(null);
  const [bgmDir, setBgmDir] = useState<string>("");
  const [bgmName, setBgmName] = useState<string | null>(null);
  const [bgmUploading, setBgmUploading] = useState(false);
  const [overlayTemplates, setOverlayTemplates] = useState<OverlayTemplate[]>([]);
  const [selectedOverlayTpl, setSelectedOverlayTpl] = useState<string | null>(null);
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplName, setTplName] = useState("");

  useEffect(() => {
    getTemplates().then(setTemplates).catch(() => {});
    getOverlayTemplates().then(setOverlayTemplates).catch(() => {});
    fetch("/api/jobs")
      .then((r) => r.json())
      .then((d) => {
        const running = (d.jobs || []).find((j: { status: string }) => j.status === "running");
        if (running) setActiveRunningJob(running.id);
      })
      .catch(() => {});
  }, []);

  const handleFile = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const { videoPath: vp, name } = await uploadVideo(file);
      setVideoPath(vp);
      setVideoName(name);
      setLastVideoPath(vp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const handleOverlayFile = async (file: File) => {
    setError(null);
    setOverlayUploading(true);
    try {
      const { videoPath: vp, name } = await uploadVideo(file);
      setOverlayImage(vp);
      setOverlayImageName(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOverlayUploading(false);
    }
  };

  const handleSaveOverlayTpl = async () => {
    setError(null);
    setSavingTpl(true);
    try {
      const name = tplName.trim() || overlayImageName || `overlay-${Date.now()}`;
      await saveOverlayTemplate({
        id: selectedOverlayTpl || undefined,
        name,
        html: overlayHtml,
        css: overlayCss,
      });
      setSelectedOverlayTpl(null);
      setTplName("");
      await getOverlayTemplates().then(setOverlayTemplates).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingTpl(false);
    }
  };

  const handleLoadOverlayTpl = async (id: string) => {
    setError(null);
    const tpl = await loadOverlayTemplate(id);
    if (tpl) {
      setOverlayHtml(tpl.html);
      setOverlayCss(tpl.css);
      setSelectedOverlayTpl(tpl.id);
      setTplName(tpl.name);
    }
  };

  const handleDeleteOverlayTpl = async (id: string) => {
    setError(null);
    await deleteOverlayTemplate(id).catch(() => {});
    if (selectedOverlayTpl === id) setSelectedOverlayTpl(null);
    setOverlayTemplates((prev) => prev.filter((t) => t.id !== id));
  };

  const handleBgmFile = async (file: File) => {
    setError(null);
    setBgmUploading(true);
    try {
      const { videoPath, name } = await uploadVideo(file);
      setBgmPath(videoPath);
      setBgmName(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBgmUploading(false);
    }
  };

  // Picker folder (explorer) -> upload semua audio ke pustaka server -> random per run.
  const handleBgmFolder = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setBgmUploading(true);
    try {
      let n = 0;
      for (const f of Array.from(files)) {
        if (!/audio\/|(\.mp3|\.wav|\.flac|\.ogg|\.m4a|\.aac)$/i.test(f.type + " " + f.name)) continue;
        await uploadVideo(f, "bgm");
        n++;
      }
      if (!n) throw new Error("tidak ada file audio di folder itu");
      setBgmPath(null);
      setBgmName(null);
      setBgmDir("/app/data/bgm");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBgmUploading(false);
    }
  };

  const handleVoiceRefFile = async (file: File) => {
    setError(null);
    setVoiceRefUploading(true);
    try {
      // Read as base64 and pass directly
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        setVoiceRef(base64);
        setVoiceRefName(file.name);
      };
      reader.readAsDataURL(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVoiceRefUploading(false);
    }
  };

  const handleRun = async () => {
    if (!videoPath) {
      setError("Pilih video dulu (upload atau pakai path yang sudah ada).");
      return;
    }
    setError(null);
    setRunning(true);
    try {
      const { jobId } = await runPipeline({
        videoPath,
        model: model || undefined,
        prompt: prompt.trim() || undefined,
        chunk: chunk ? 40 : false,
        stretch: stretch !== undefined && !Number.isNaN(stretch) ? stretch : undefined,
        hzoom: hzoom !== undefined && !Number.isNaN(hzoom) ? hzoom : undefined,
        mirror: mirror || undefined,
        grain: grain || undefined,
        speedMin: speedMin !== undefined && !Number.isNaN(speedMin) ? speedMin : undefined,
        speedMax: speedMax !== undefined && !Number.isNaN(speedMax) ? speedMax : undefined,
        caption,
        template,
        lead,
        tail,
        outputMode,
        parts: outputMode === "manual" ? parts : undefined,
        minutesPerPart: outputMode === "auto" ? minutesPerPart : undefined,
        targetMinutes: outputMode === "one" && targetMinutes > 0 ? targetMinutes : undefined,
        overlayMode,
        overlayImage: overlayMode === "image" ? overlayImage || undefined : undefined,
        overlayHtml: overlayMode === "css" ? overlayHtml : undefined,
        overlayCss: overlayMode === "css" ? overlayCss : undefined,
        colorGrade,
        voiceRef: voiceRef || undefined,
        language: language || undefined,
        bgm: bgmPath || undefined,
        bgmDir: !bgmPath && bgmDir.trim() ? bgmDir.trim() : undefined,
        whisperQuality: whisperQuality || undefined,
        ttsModel: ttsModel.trim() || undefined,
      });
      navigate(`/jobs/${encodeURIComponent(jobId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#B6FF3B] text-black">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-black tracking-tight text-white">New Clip</h1>
          <p className="text-sm text-[#a1a1aa]">
            Upload → <span className="text-white">POST /api/run</span> one-shot <code className="rounded bg-[#0A0A0A] border border-[#27272A] px-1 py-0.5 text-white">final_captioned_loki.mp4</code>
          </p>
        </div>
      </div>

      {activeRunningJob && (
        <div className="flex items-center gap-2 rounded-2xl border border-amber-900 bg-amber-950/50 p-3 text-sm text-amber-200">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Job <span className="font-mono text-amber-100">{activeRunningJob}</span> masih running — hanya 1 job aktif (RAM/VRAM).
        </div>
      )}

      <section className="rounded-[20px] border border-[#27272A] bg-[#0A0A0A] p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-black text-white">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#B6FF3B] text-black">
            <Clapperboard className="h-4 w-4" />
          </span>
          1 · Video Source
        </div>
        <VideoDropzone onFile={handleFile} disabled={uploading} />
        {uploading && (
          <p className="mt-2 flex items-center gap-2 text-xs text-[#a1a1aa]">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[#B6FF3B]" /> Mengupload…
          </p>
        )}
        {videoPath && (
          <div className="mt-3 rounded-xl bg-[#000000] border border-[#27272A] p-3 text-xs">
            <p className="font-mono break-all text-white">{videoPath}</p>
            {videoName && <p className="text-[#a1a1aa]">{videoName}</p>}
            <p className="mt-1 text-[#71717a]">Path → <code className="rounded bg-[#1A1A1A] px-1">videoPath</code> ke <code className="rounded bg-[#1A1A1A] px-1">/api/run</code></p>
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <input
            value={videoPath || ""}
            onChange={(e) => {
              setVideoPath(e.target.value || null);
              if (e.target.value) setLastVideoPath(e.target.value);
            }}
            placeholder="atau tempel path manual, mis. C:\Users\X\Downloads\getvid.mp4"
            className="flex-1 rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white placeholder:text-[#71717a] focus:border-[#B6FF3B]/40 focus:outline-none"
          />
          <button
            onClick={() => {
              setVideoPath(null);
              setLastVideoPath(null);
            }}
            className="rounded-xl border border-[#27272A] bg-[#1A1A1A] px-4 py-2 text-sm font-semibold text-[#a1a1aa] hover:bg-[#27272A] hover:text-white"
          >
            Clear
          </button>
        </div>
      </section>

      <section className="rounded-[20px] border border-[#27272A] bg-[#0A0A0A] p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-black text-white">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#1A1A1A] text-white border border-[#27272A]">
            <Settings2 className="h-4 w-4" />
          </span>
          2 · Konfigurasi Pipeline
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Model (MODEL_NAME)</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="ag/gemini-3.6-flash-high"
              className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white placeholder:text-[#71717a] focus:border-[#B6FF3B]/40 focus:outline-none"
            />
            <span className="text-xs text-[#71717a]">OpenAI Compatible via OPENAI_BASE_URL</span>
          </label>

          <label className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Chunk</span>
            <div className="flex items-center gap-2 rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5">
              <input type="checkbox" checked={chunk} onChange={(e) => setChunk(e.target.checked)} className="h-4 w-4 rounded accent-[#B6FF3B]" />
              <span className="text-sm font-medium text-white">{chunk ? "40s chunk (aman 3-8s)" : "FULL tanpa chunk"}</span>
            </div>
          </label>

          <label className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Output Mode</span>
            <select
              value={outputMode}
              onChange={(e) => setOutputMode(e.target.value as typeof outputMode)}
              className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white focus:border-[#B6FF3B]/40 focus:outline-none"
            >
              <option value="one">One Short — single file</option>
              <option value="auto">Auto Split (target menit/part)</option>
              <option value="manual">Manual Split (N part)</option>
            </select>
          </label>

          <label className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Color Grading</span>
            <select
              value={colorGrade}
              onChange={(e) => setColorGrade(e.target.value as typeof colorGrade)}
              className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white focus:border-[#B6FF3B]/40 focus:outline-none"
            >
              <option value="random">Random (server pilih)</option>
              <option value="normal">Normal (tanpa grading)</option>
              <option value="cinematic">Cinematic (teal-orange)</option>
              <option value="warm">Warm (hangat)</option>
              <option value="cool">Cool (dingin)</option>
              <option value="vivid">Vivid (kontras cerah)</option>
              <option value="vintage">Vintage (retro pudar)</option>
              <option value="dramatic">Dramatic (kontras tinggi)</option>
            </select>
          </label>

          {outputMode === "auto" ? (
            <label className="space-y-1.5">
              <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Minutes per Part</span>
              <input
                type="number"
                value={minutesPerPart}
                onChange={(e) => setMinutesPerPart(Number(e.target.value))}
                min={1}
                max={10}
                className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white focus:border-[#B6FF3B]/40 focus:outline-none"
              />
            </label>
          ) : outputMode === "manual" ? (
            <label className="space-y-1.5">
              <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Parts</span>
              <input
                type="number"
                value={parts}
                onChange={(e) => setParts(Number(e.target.value))}
                min={1}
                max={20}
                className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white focus:border-[#B6FF3B]/40 focus:outline-none"
              />
            </label>
          ) : (
            <label className="space-y-1.5">
              <span className="text-xs font-bold tracking-wide text-[#a1a1aa] flex items-center gap-1">
                <Scissors className="h-3 w-3" /> Target Minutes (Recap, 0=off)
              </span>
              <input
                type="number"
                value={targetMinutes}
                onChange={(e) => setTargetMinutes(Number(e.target.value))}
                min={0}
                max={30}
                className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white focus:border-[#B6FF3B]/40 focus:outline-none"
              />
            </label>
          )}

          <label className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Stretch 0..1</span>
            <input
              type="number"
              step="0.1"
              value={stretch ?? ""}
              onChange={(e) => setStretch(parseNum(e.target.value))}
              placeholder="kosong = default"
              className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white placeholder:text-[#71717a] focus:border-[#B6FF3B]/40 focus:outline-none"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">hZoom &gt;1</span>
            <input
              type="number"
              step="0.05"
              value={hzoom ?? ""}
              onChange={(e) => setHzoom(parseNum(e.target.value))}
              placeholder="1.15"
              className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white placeholder:text-[#71717a] focus:border-[#B6FF3B]/40 focus:outline-none"
            />
          </label>

          <label className="flex items-center gap-2 text-xs font-bold tracking-wide text-[#a1a1aa]">
            <input
              type="checkbox"
              checked={mirror}
              onChange={(e) => setMirror(e.target.checked)}
              className="h-4 w-4 accent-[#B6FF3B]"
            />
            Mirror (flip horizontal)
          </label>

          <label className="flex items-center gap-2 text-xs font-bold tracking-wide text-[#a1a1aa]">
            <input
              type="checkbox"
              checked={grain}
              onChange={(e) => setGrain(e.target.checked)}
              className="h-4 w-4 accent-[#B6FF3B]"
            />
            Grain (noise anti-fingerprint)
          </label>

          <div className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Preview frame 9:16</span>            <div className="flex items-end gap-2">
              <input
                type="number"
                min={0}
                value={previewAtSec ?? ""}
                onChange={(e) => setPreviewAtSec(parseNum(e.target.value))}
                placeholder="12"
                title="Detik"
                className="w-[80px] rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white placeholder:text-[#71717a] focus:border-[#B6FF3B]/40 focus:outline-none"
              />
              <button
                onClick={handlePreview}
                disabled={previewLoading || !videoPath}
                className="rounded-xl border border-[#B6FF3B]/40 bg-[#B6FF3B]/10 px-4 py-2.5 text-sm font-bold text-white hover:bg-[#B6FF3B]/20 disabled:opacity-50 transition-colors"
              >
                {previewLoading ? "..." : "Preview"}
              </button>
            </div>
            {previewError && <p className="text-xs text-red-400">{previewError}</p>}
            {previewImg && (
              <img src={previewImg} alt="Preview frame" className="mt-1 h-[288px] w-[162px] rounded-lg border border-[#27272A] object-cover" />
            )}
          </div>

          <label className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Tempo min..max (ikut narasi)</span>
            <div className="flex gap-2">
              <input
                type="number" step="0.1" min={0.1} max={8}
                value={speedMin ?? ""}
                onChange={(e) => setSpeedMin(parseNum(e.target.value))}
                placeholder="0.5"
                title="Batas lambat"
                className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white placeholder:text-[#71717a] focus:border-[#B6FF3B]/40 focus:outline-none"
              />
              <input
                type="number" step="0.5" min={1} max={8}
                value={speedMax ?? ""}
                onChange={(e) => setSpeedMax(parseNum(e.target.value))}
                placeholder="2"
                title="Batas cepat"
                className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white placeholder:text-[#71717a] focus:border-[#B6FF3B]/40 focus:outline-none"
              />
            </div>
          </label>

          <label className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Bahasa (TTS + Caption)</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white focus:border-[#B6FF3B]/40 focus:outline-none"
            >
              <option value="Indonesian">Indonesia</option>
              <option value="English">English</option>
              <option value="Japanese">Japanese</option>
              <option value="Korean">Korean</option>
              <option value="Mandarin">Mandarin</option>
              <option value="Arabic">Arabic</option>
              <option value="Hindi">Hindi</option>
              <option value="Spanish">Spanish</option>
              <option value="French">French</option>
              <option value="German">German</option>
              <option value="Portuguese">Portuguese</option>
              <option value="Russian">Russian</option>
              <option value="Thai">Thai</option>
              <option value="Vietnamese">Vietnamese</option>
              <option value="Turkish">Turkish</option>
              <option value="Dutch">Dutch</option>
              <option value="Polish">Polish</option>
              <option value="Italian">Italian</option>
              <option value="Swedish">Swedish</option>
              <option value="Ukrainian">Ukrainian</option>
            </select>
            <span className="text-xs text-[#71717a]">Otomatis ke TTS + Whisper caption</span>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Whisper Quality</span>
            <select
              value={whisperQuality}
              onChange={(e) => setWhisperQuality(e.target.value as typeof whisperQuality)}
              className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white focus:border-[#B6FF3B]/40 focus:outline-none"
            >
              <option value="tiny">Tiny — tercepat, akurasi rendah</option>
              <option value="base">Base — seimbang</option>
              <option value="small">Small — lebih akurat</option>
              <option value="medium">Medium — paling akurat (default)</option>
            </select>
            <span className="text-xs text-[#71717a]">Ukuran model & kecepatan transcription</span>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">TTS Model</span>
            <select
              value={ttsModel}
              onChange={(e) => setTtsModel(e.target.value)}
              className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white focus:border-[#B6FF3B]/40 focus:outline-none"
            >
              <option value="higgs-tts-q4">higgs-tts-q4 (default)</option>
              <option value="omnivoice">omnivoice</option>
            </select>
            <span className="text-xs text-[#71717a]">Harus terdaftar di server.json audiocpp</span>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Lead (s)</span>
            <input
              type="number"
              value={lead}
              onChange={(e) => setLead(Number(e.target.value))}
              className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white focus:border-[#B6FF3B]/40 focus:outline-none"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Tail (s)</span>
            <input
              type="number"
              value={tail}
              onChange={(e) => setTail(Number(e.target.value))}
              className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white focus:border-[#B6FF3B]/40 focus:outline-none"
            />
          </label>

          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Prompt (opsional)</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="Instruksi tambahan buat AI, mis. fokus ke adegan aksi, gaya narasi horor, jangan pakai bahasa gaul..."
              className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 text-sm text-white placeholder:text-[#71717a] focus:border-[#B6FF3B]/40 focus:outline-none"
            />
            <span className="text-xs text-[#71717a]">Kosongkan = prompt default. Dikirim ke VLM analisis + narasi stage 2.</span>
          </label>
        </div>

        <label className="mt-4 flex items-center gap-2 rounded-xl border border-[#B6FF3B]/20 bg-[#B6FF3B]/10 px-3 py-2.5 cursor-pointer">
          <input type="checkbox" checked={caption} onChange={(e) => setCaption(e.target.checked)} className="h-4 w-4 rounded accent-[#B6FF3B]" />
          <span className="text-sm font-semibold text-white">Caption ON</span>
          <span className="text-xs text-[#a1a1aa]">— tscaps headless + template repo</span>
        </label>
      </section>

      <section className="rounded-[20px] border border-[#27272A] bg-[#0A0A0A] p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-black text-white">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#B6FF3B] text-black">
            <PaletteIcon className="h-4 w-4" />
          </span>
          3 · Template <span className="text-xs font-medium text-[#a1a1aa]">dari GET /api/templates</span>
        </div>
        <TemplateGrid templates={templates} selectedId={template} onSelect={setTemplate} />
        <p className="mt-3 text-xs text-[#71717a]">
          Dir: <code className="rounded bg-[#000000] border border-[#27272A] px-1 py-0.5 text-white">templates/</code> · Pilih <span className="text-white">loki</span> untuk default.
        </p>
      </section>

      <section className="rounded-[20px] border border-[#27272A] bg-[#0A0A0A] p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-black text-white">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#B6FF3B] text-black">
            <Layers className="h-4 w-4" />
          </span>
          4 · Overlay <span className="text-xs font-medium text-[#a1a1aa]">ditempel sebelum caption · kanvas 9:16</span>
        </div>
        <div className="mb-3 flex gap-2">
          {(["none", "image", "css"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setOverlayMode(m)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${overlayMode === m ? "border-[#B6FF3B] bg-[#B6FF3B]/10 text-white" : "border-[#27272A] text-[#a1a1aa]"}`}
            >
              {m === "none" ? "Tanpa" : m === "image" ? "Gambar PNG" : "HTML+CSS"}
            </button>
          ))}
        </div>
        {overlayMode === "image" && (
          <div>
            <label className="block cursor-pointer rounded-xl border border-dashed border-[#27272A] px-3 py-3 text-center text-xs text-[#a1a1aa]">
              <input
                type="file"
                accept="image/png"
                className="hidden"
                disabled={overlayUploading}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleOverlayFile(f); e.target.value = ""; }}
              />
              {overlayUploading ? "Uploading…" : overlayImageName ? `✓ ${overlayImageName}` : "Upload PNG 9:16 (mis. 1080×1920)"}
            </label>
            <p className="mt-1.5 text-xs text-[#71717a]">Wajib 9:16 — selain itu ditolak pipeline.</p>
          </div>
        )}
        {overlayMode === "css" && (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <label className="block space-y-1.5">
                <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">HTML (di dalam body 1080×1920 transparan)</span>
                <textarea
                  value={overlayHtml}
                  onChange={(e) => setOverlayHtml(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2 font-mono text-xs text-white focus:border-[#B6FF3B]/40 focus:outline-none"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">CSS (full custom kayak studio)</span>
                <textarea
                  value={overlayCss}
                  onChange={(e) => setOverlayCss(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2 font-mono text-xs text-white focus:border-[#B6FF3B]/40 focus:outline-none"
                />
              </label>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-bold tracking-wide text-[#a1a1aa]">Preview 9:16</p>
              <div className="relative h-[288px] w-[162px] overflow-hidden rounded-lg border border-[#27272A] bg-[repeating-conic-gradient(#1a1a1a_0_25%,#0a0a0a_0_50%)_0_0/16px_16px]">
                <style>{overlayCss}</style>
                <div className="absolute left-0 top-0 origin-top-left" style={{ width: 1080, height: 1920, transform: "scale(0.15)" }} dangerouslySetInnerHTML={{ __html: overlayHtml }} />
              </div>
            </div>
          </div>
        )}
        {overlayMode === "css" && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              value={selectedOverlayTpl || ""}
              onChange={(e) => { if (e.target.value) handleLoadOverlayTpl(e.target.value); else setSelectedOverlayTpl(null); }}
              className="rounded-lg border border-[#27272A] bg-[#0A0A0A] px-3 py-1.5 text-xs text-white focus:border-[#B6FF3B]/40 focus:outline-none"
            >
              <option value="">-- Load Template --</option>
              {overlayTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Nama template..."
              value={tplName}
              onChange={(e) => setTplName(e.target.value)}
              className="rounded-lg border border-[#27272A] bg-[#0A0A0A] px-3 py-1.5 text-xs text-white placeholder-[#71717a] focus:border-[#B6FF3B]/40 focus:outline-none w-[160px]"
            />
            <button
              onClick={handleSaveOverlayTpl}
              disabled={savingTpl}
              className="inline-flex items-center gap-1 rounded-lg border border-[#B6FF3B]/40 bg-[#B6FF3B]/10 px-3 py-1.5 text-xs font-bold text-white hover:bg-[#B6FF3B]/20 disabled:opacity-50 transition-colors"
            >
              <Save className="h-3 w-3" /> {savingTpl ? "Saving..." : "Save Template"}
            </button>
            {selectedOverlayTpl && (
              <button
                onClick={() => handleDeleteOverlayTpl(selectedOverlayTpl)}
                className="inline-flex items-center gap-1 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs font-bold text-red-400 hover:bg-red-950/60 transition-colors"
              >
                <Trash2 className="h-3 w-3" /> Delete
              </button>
            )}
            {overlayTemplates.length > 0 && (
              <p className="ml-auto text-[10px] text-[#71717a]">{overlayTemplates.length} template tersimpan</p>
            )}
          </div>
        )}
      </section>

      <section className="rounded-[20px] border border-[#27272A] bg-[#0A0A0A] p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-black text-white">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#B6FF3B] text-black">
            <Music className="h-4 w-4" />
          </span>
          4 · Musik Latar (BGM) <span className="text-xs font-medium text-[#a1a1aa]">di-mix ke narasi · mp3/flac/wav</span>
        </div>
        <label className="block cursor-pointer rounded-xl border border-dashed border-[#27272A] px-3 py-3 text-center text-xs text-[#a1a1aa] hover:border-[#B6FF3B]/40">
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            disabled={bgmUploading}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBgmFile(f); e.target.value = ""; }}
          />
          {bgmUploading ? "Uploading..." : bgmName ? `✓ ${bgmName}` : "Upload musik latar (opsional)"}
        </label>
        {bgmPath && (
          <p className="text-xs text-[#B6FF3B]">BGM aktif · {bgmName}</p>
        )}
        <label className="mt-2 block space-y-1.5">
          <span className="text-xs font-bold tracking-wide text-[#a1a1aa]">Atau folder pustaka (random 1 lagu per run)</span>
          <label className="block cursor-pointer rounded-xl border border-dashed border-[#27272A] px-3 py-2.5 text-center text-xs text-[#a1a1aa] hover:border-[#B6FF3B]/40">
            <input
              type="file"
              className="hidden"
              disabled={bgmUploading}
              // @ts-expect-error webkitdirectory non-standar tapi didukung Chromium
              webkitdirectory=""
              onChange={(e) => { handleBgmFolder(e.target.files); e.target.value = ""; }}
            />
            {bgmUploading ? "Uploading..." : bgmDir ? `✓ pustaka: ${bgmDir}` : "Pilih folder musik (explorer)..."}
          </label>
          <input
            type="text"
            value={bgmDir}
            onChange={(e) => setBgmDir(e.target.value)}
            placeholder="/app/data/bgm"
            className="w-full rounded-xl border border-[#27272A] bg-[#000000] px-3 py-2.5 font-mono text-xs text-white placeholder:text-[#71717a] focus:border-[#B6FF3B]/40 focus:outline-none"
          />
        </label>
        <p className="mt-2 text-xs text-[#71717a]">
          Kosongkan = tanpa musik. Isi = audio di-mix otomatis dengan narasi TTS.
        </p>
      </section>

      <section className="rounded-[20px] border border-[#27272A] bg-[#0A0A0A] p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-black text-white">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#B6FF3B] text-black">
            <Mic2 className="h-4 w-4" />
          </span>
          5 · TTS & Voice Clone
        </div>
        <p className="text-xs leading-relaxed text-[#a1a1aa] mb-4">
          TTS via <code className="rounded bg-[#000000] border border-[#27272A] px-1 py-0.5 text-white">audiocpp_server</code> HTTP API
          · Speaker reference untuk voice cloning (base64 WAV).
        </p>
        <div className="space-y-3">
          <label className="block cursor-pointer rounded-xl border border-dashed border-[#27272A] px-3 py-3 text-center text-xs text-[#a1a1aa] hover:border-[#B6FF3B]/40">
            <input
              type="file"
              accept="audio/wav,audio/*"
              className="hidden"
              disabled={voiceRefUploading}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleVoiceRefFile(f); e.target.value = ""; }}
            />
            {voiceRefUploading ? "Loading..." : voiceRefName ? `✓ ${voiceRefName}` : "Upload Voice Reference (WAV) — optional"}
          </label>
          {voiceRef && (
            <p className="text-xs text-[#B6FF3B]">Voice clone aktif · {voiceRefName}</p>
          )}
          <p className="text-xs text-[#71717a]">
            Kosongkan = default voice. Isi = clone dari audio referensi.
          </p>
        </div>
      </section>

      {error && (
        <div className="flex items-center gap-2 rounded-2xl border border-red-900 bg-red-950 p-3 text-sm text-red-300">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      <button
        onClick={handleRun}
        disabled={running || !videoPath || !!activeRunningJob}
        className="inline-flex w-full items-center justify-center gap-2 rounded-[16px] bg-[#B6FF3B] px-6 py-4 text-sm font-black text-black hover:bg-[#9AE600] disabled:opacity-50 active:scale-[0.98] transition-[transform,background-color] duration-150"
      >
        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
        {running ? "Menjalankan pipeline…" : "Run Pipeline →"}
      </button>

      <p className="text-center text-xs text-[#71717a]">analysis → condense → TTS audio.cpp → split → render FFmpeg → caption tscaps · Narasi = master timeline</p>
    </div>
  );
}

function PaletteIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="13.5" cy="6.5" r="0.5" />
      <circle cx="17.5" cy="10.5" r="0.5" />
      <circle cx="8.5" cy="7.5" r="0.5" />
      <circle cx="6.5" cy="12.5" r="0.5" />
      <path d="M12 22a7 7 0 0 0 7-7c0-3.5-2-6.5-7-10-5 3.5-7 6.5-7 10a7 7 0 0 0 7 7z" />
    </svg>
  );
}
