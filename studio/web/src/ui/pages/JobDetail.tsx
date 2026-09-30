import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { cancelJob, connectJobWS, fileUrl, getJob, getJobLog, addBgm, uploadVideo, runPipeline, type Job, type JobLogEntry } from "@/app/api/client";
import { LogViewer } from "@/ui/components/LogViewer";
import { VideoPlayer } from "@/ui/components/VideoPlayer";
import { ArtifactList } from "@/ui/components/ArtifactList";
import { StatusBadge, StageBadge } from "@/ui/components/StatusBadge";
import { AlertCircle, ArrowLeft, Ban, Loader2, RefreshCw, Download, Sparkles, RotateCcw } from "lucide-react";

function fmtDate(v?: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function durStr(start?: string | null, end?: string | null): string {
  if (!start || !end) return "";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return `${h}j ${m}m`;
  if (m > 0) return `${m}m ${ss}dtk`;
  return `${ss}dtk`;
}

export function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<JobLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [bgmName, setBgmName] = useState<string | null>(null);
  const [bgmPath, setBgmPath] = useState<string | null>(null);
  const [bgmLevel, setBgmLevel] = useState(0.2);
  const [bgmBusy, setBgmBusy] = useState(false);
  const [bgmError, setBgmError] = useState<string | null>(null);
  const [bgmDir, setBgmDir] = useState<string>("");
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const handleBgmFile = async (f: File | undefined) => {
    if (!f) return;
    setBgmBusy(true);
    setBgmError(null);
    try {
      const r = await uploadVideo(f);
      setBgmPath(r.videoPath);
      setBgmName(r.name || f.name);
    } catch (e) {
      setBgmError(e instanceof Error ? e.message : String(e));
    } finally {
      setBgmBusy(false);
    }
  };
  const handleBgmFolder = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBgmBusy(true);
    setBgmError(null);
    try {
      let n = 0;
      for (const f of Array.from(files)) {
        if (!/audio\/|(\.mp3|\.wav|\.flac|\.ogg|\.m4a|\.aac)$/i.test(f.type + " " + f.name)) continue;
        await uploadVideo(f, "bgm");
        n++;
      }
      if (!n) throw new Error("tidak ada file audio di folder itu");
      setBgmPath(null);
      setBgmName(`${n} lagu`);
      setBgmDir("/app/data/bgm");
    } catch (e) {
      setBgmError(e instanceof Error ? e.message : String(e));
    } finally {
      setBgmBusy(false);
    }
  };
  const handleBgmMix = async () => {
    if (!id || (!bgmPath && !bgmDir.trim())) { setBgmError("Upload file musik / isi folder dulu"); return; }
    setBgmBusy(true);
    setBgmError(null);
    try {
      const r = await addBgm({ jobId: id, musicPath: bgmPath || undefined, musicDir: !bgmPath && bgmDir.trim() ? bgmDir.trim() : undefined, level: bgmLevel });
      if (r.picked) setBgmName(`random: ${r.picked}`);
      const j = await getJob(id);
      setJob(j);
    } catch (e) {
      setBgmError(e instanceof Error ? e.message : String(e));
    } finally {
      setBgmBusy(false);
    }
  };
  const logsRef = useRef<JobLogEntry[]>([]);

  const fetchAll = async () => {
    if (!id) return;
    try {
      setLoading(true);
      const [j, l] = await Promise.all([getJob(id), getJobLog(id)]);
      setJob(j);
      setLogs(l);
      logsRef.current = l;
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!id || !job) return;
    if (job.status !== "running" && job.status !== "queued") return;

    const unsub = connectJobWS(id, {
      onLog: (entry) => {
        logsRef.current = [...logsRef.current, entry];
        setLogs([...logsRef.current]);
      },
      onStatus: (status, stage) => {
        setJob((prev) => (prev ? { ...prev, status, stage } : prev));
        if (status === "done" || status === "error" || status === "cancelled") {
          getJob(id).then(setJob).catch(() => {});
        }
      },
      onOpen: () => setWsConnected(true),
      onClose: () => setWsConnected(false),
    });

    const poll = setInterval(() => {
      getJob(id)
        .then((j) => {
          setJob(j);
          if (j.status === "done" || j.status === "error" || j.status === "cancelled") {
            getJobLog(id)
              .then((l) => {
                logsRef.current = l;
                setLogs(l);
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }, 4000);

    return () => {
      unsub();
      clearInterval(poll);
    };
  }, [id, job?.status]);

  const handleCancel = async () => {
    if (!id) return;
    try {
      await cancelJob(id);
      await fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleResume = async () => {
    if (!id || !job?.videoPath) {
      setResumeError("Job ini tidak punya videoPath — resume tidak bisa, jalankan ulang dari New Job.");
      return;
    }
    setResumeBusy(true);
    setResumeError(null);
    try {
      const { jobId } = await runPipeline({ ...(job.config || {}), videoPath: job.videoPath, resumeJob: id });
      navigate(`/jobs/${jobId}`);
    } catch (e) {
      setResumeError(e instanceof Error ? e.message : String(e));
    } finally {
      setResumeBusy(false);
    }
  };

  if (loading && !job) {
    return (
      <div className="flex items-center gap-2 rounded-2xl bg-[#0A0A0A] border border-[#27272A] p-6 text-sm text-[#a1a1aa]">
        <Loader2 className="h-4 w-4 animate-spin text-[#B6FF3B]" /> Memuat clip…
      </div>
    );
  }

  if (error && !job) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-2xl border border-red-900 bg-red-950 p-4 text-sm text-red-300">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-[#B6FF3B]">
          <ArrowLeft className="h-4 w-4" /> Kembali ke Dashboard
        </Link>
      </div>
    );
  }

  if (!job || !id) return null;

  const hasManifestLog = logs.some((l) => l.line.includes("[analysis] selesai") || l.line.includes("[resume] manifest"));
  const canResume = job.status === "error" && !!job.videoPath && hasManifestLog;
  const resumeDisabledReason = !job.videoPath
    ? "videoPath tidak ada di job ini"
    : !hasManifestLog
      ? "Analysis belum selesai (belum ada manifest) — harus ulang penuh dari New Job"
      : "";

  const videoArtifacts = job.artifacts.filter(
    (a, i, arr) => a.kind === "video" && arr.findIndex((b) => b.name === a.name) === i
  );
  const primaryVideo = videoArtifacts.find((a) => a.name.includes("final_captioned")) || videoArtifacts[0] || null;
  const srtArtifact = job.artifacts.find((a) => a.kind === "srt" || a.name.endsWith(".srt"));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#a1a1aa] hover:text-white">
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchAll}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#0A0A0A] border border-[#27272A] px-3 py-1.5 text-xs font-semibold text-[#a1a1aa] hover:bg-[#1A1A1A] hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
          {job.status === "error" && (
            <button
              onClick={handleResume}
              disabled={!canResume || resumeBusy}
              title={canResume ? "Resume: pakai manifest analysis job ini, lanjut condense → TTS → render → caption" : resumeDisabledReason}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#B6FF3B] px-3 py-1.5 text-xs font-black text-black hover:bg-[#9AE600] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw className={`h-3.5 w-3.5 ${resumeBusy ? "animate-spin" : ""}`} /> {resumeBusy ? "Resume…" : "Resume"}
            </button>
          )}
          {(job.status === "running" || job.status === "queued") && (
            <button
              onClick={handleCancel}
              className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1.5 text-xs font-black text-white hover:bg-red-700"
            >
              <Ban className="h-3.5 w-3.5" /> Cancel
            </button>
          )}
        </div>
      </div>

      <div className="rounded-[20px] bg-[#0A0A0A] border border-[#27272A] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#B6FF3B] text-black">
                <Sparkles className="h-4 w-4" />
              </span>
              <h1 className="truncate font-mono text-sm font-black text-white">{job.id}</h1>
            </div>
            <p className="mt-1 text-xs text-[#a1a1aa]">
              Dibuat {fmtDate(job.createdAt)} {job.finishedAt ? `· Selesai ${fmtDate(job.finishedAt)}` : ""}{" "}
              {durStr(job.createdAt, job.finishedAt) ? `· Durasi ${durStr(job.createdAt, job.finishedAt)}` : ""}{" "}
              <span className={wsConnected ? "text-[#B6FF3B]" : "text-[#71717a]"}>· {wsConnected ? "WS live" : "WS offline (polling)"}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={job.status} stage={job.stage} />
            <StageBadge stage={job.stage} />
          </div>
        </div>
        {job.error && <div className="mt-3 rounded-xl bg-red-950 border border-red-900 p-3 text-sm text-red-300">{job.error}</div>}
        {resumeError && <div className="mt-3 rounded-xl bg-red-950 border border-red-900 p-3 text-sm text-red-300">{resumeError}</div>}
        {job.status === "running" && <p className="mt-2 text-xs text-amber-400">Pipeline berjalan. Jangan tutup tab — log streaming via WS.</p>}
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          {primaryVideo ? (
            <div className="space-y-3">
              <div className="rounded-[20px] overflow-hidden bg-black border border-[#27272A] p-2">
                <VideoPlayer src={fileUrl(id, primaryVideo.name)} className="aspect-[9/16] max-h-[720px] mx-auto w-full max-w-[360px] rounded-xl overflow-hidden" />
              </div>
              <p className="text-center text-xs text-[#71717a]">
                {primaryVideo.name} · <code className="rounded bg-[#0A0A0A] border border-[#27272A] px-1 py-0.5 text-[#a1a1aa]">/files/{id}/{primaryVideo.name}</code>
              </p>
              {videoArtifacts.length > 1 && (
                <div className="flex flex-wrap gap-2 justify-center">
                  {videoArtifacts.map((v) => (
                    <a
                      key={v.name}
                      href={fileUrl(id, v.name)}
                      target="_blank"
                      rel="noreferrer"
                      className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                        v.name === primaryVideo.name ? "border-[#B6FF3B] bg-[#B6FF3B] text-black" : "border-[#27272A] bg-[#0A0A0A] text-[#a1a1aa] hover:border-[#B6FF3B]/30"
                      }`}
                    >
                      {v.name}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex aspect-[9/16] max-h-[520px] items-center justify-center rounded-[20px] border border-dashed border-[#27272A] bg-[#0A0A0A] text-sm text-[#a1a1aa]">
              {job.status === "done" ? "Tidak ada video. Cek log untuk error render/caption." : "Video akan muncul setelah stage render."}
            </div>
          )}

          {srtArtifact && (
            <a
              href={fileUrl(id, srtArtifact.name)}
              download
              className="inline-flex items-center gap-2 rounded-xl bg-[#B6FF3B] px-4 py-2 text-sm font-black text-black hover:bg-[#9AE600]"
            >
              <Download className="h-4 w-4" /> Download SRT {srtArtifact.name}
            </a>
          )}

          {job.status !== "running" && (
            <div className="rounded-[20px] border border-[#27272A] bg-[#0A0A0A] p-4">
              <h2 className="mb-2 text-sm font-black text-white">Musik latar (BGM)</h2>
              <label className="block cursor-pointer rounded-xl border border-dashed border-[#27272A] bg-[#000000] px-3 py-2.5 text-center text-xs text-[#a1a1aa] hover:border-[#B6FF3B]/40">
                {bgmName ? bgmName : "Upload mp3/wav/flac..."}
                <input type="file" accept="audio/*,.flac" className="hidden" onChange={(e) => handleBgmFile(e.target.files?.[0])} />
              </label>
              <label className="mt-2 block cursor-pointer rounded-xl border border-dashed border-[#27272A] bg-[#000000] px-3 py-2 text-center text-xs text-[#71717a] hover:border-[#B6FF3B]/40">
                {bgmDir ? `✓ pustaka: ${bgmDir}` : "atau pilih folder musik..."}
                <input
                  type="file" className="hidden"
                  // @ts-expect-error webkitdirectory non-standar tapi didukung Chromium
                  webkitdirectory=""
                  onChange={(e) => { handleBgmFolder(e.target.files); e.target.value = ""; }}
                />
              </label>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs text-[#71717a]">Level</span>
                <input
                  type="number" min={0} max={1} step={0.05} value={bgmLevel}
                  onChange={(e) => setBgmLevel(Math.min(1, Math.max(0, Number(e.target.value) || 0)))}
                  className="w-[80px] rounded-lg border border-[#27272A] bg-[#000000] px-2 py-1.5 text-xs text-white focus:border-[#B6FF3B]/40 focus:outline-none"
                />
                <button
                  onClick={handleBgmMix}
                  disabled={bgmBusy || (!bgmPath && !bgmDir.trim())}
                  className="rounded-lg border border-[#B6FF3B]/40 bg-[#B6FF3B]/10 px-3 py-1.5 text-xs font-bold text-white hover:bg-[#B6FF3B]/20 disabled:opacity-50 transition-colors"
                >
                  {bgmBusy ? "..." : "Mix ke video"}
                </button>
              </div>
              <input
                type="text"
                value={bgmDir}
                onChange={(e) => setBgmDir(e.target.value)}
                placeholder="atau folder random: /app/data/bgm"
                className="mt-2 w-full rounded-lg border border-[#27272A] bg-[#000000] px-3 py-1.5 font-mono text-xs text-white placeholder:text-[#71717a] focus:border-[#B6FF3B]/40 focus:outline-none"
              />
              {bgmError && <p className="mt-1 text-xs text-red-400">{bgmError}</p>}
              <p className="mt-1 text-xs text-[#71717a]">Hasil: <code>final_with_bgm.mp4</code> di artifacts.</p>
            </div>
          )}
        </div>

        <div className="space-y-4 lg:col-span-2">
          <div className="rounded-[20px] bg-[#0A0A0A] border border-[#27272A] p-4">
            <h2 className="mb-2 text-sm font-black text-white flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#B6FF3B] animate-pulse" /> Live Log
            </h2>
            <LogViewer logs={logs} />
            <p className="mt-2 text-xs text-[#71717a]">{logs.length} baris · cap 4000</p>
          </div>

          <div className="rounded-[20px] bg-[#0A0A0A] border border-[#27272A] p-4">
            <h2 className="mb-2 text-sm font-black text-white">Artifacts ({job.artifacts.length})</h2>
            <ArtifactList jobId={id} artifacts={job.artifacts} />
          </div>

          <div className="rounded-[20px] bg-[#0A0A0A] border border-[#27272A] p-4">
            <h3 className="text-sm font-black text-white">Tips</h3>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-[#a1a1aa]">
              <li>Seek video besar pakai Range — tidak perlu download penuh.</li>
              <li>Jika caption gagal, fallback `final_short.mp4` tetap ada.</li>
              <li>
                Path: <code className="rounded bg-[#000000] border border-[#27272A] px-1">data/output/jobs/{id}</code>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
