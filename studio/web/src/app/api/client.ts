export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";
export type JobStage = "analysis" | "condense" | "tts" | "split" | "render" | "overlay" | "caption" | null;

export interface JobArtifact {
  name: string;
  path: string;
  kind: "video" | "srt" | "audio" | "json" | "text";
}
export interface JobLogEntry {
  t: string;
  level: "info" | "out" | "err" | "warn";
  line: string;
}
export interface Job {
  id: string;
  status: JobStatus;
  stage: JobStage;
  error: string | null;
  videoPath: string | null;
  config: RunPayload | null;
  createdAt: string;
  finishedAt: string | null;
  artifacts: JobArtifact[];
  log?: JobLogEntry[];
}
export interface JobsListItem {
  id: string;
  status: JobStatus;
  stage: JobStage;
  createdAt: string;
  finishedAt: string | null;
  artifacts: string[];
}
export interface TemplateMeta {
  id: string;
  name: string;
  swatch: string;
  css: string;
  filters: string;
  json: Record<string, unknown> & {
    rendering?: { splitWordsIntoLetters?: boolean };
    typography?: {
      fontFamily?: string;
      fontWeight?: number;
      fontSize?: number;
      letterSpacing?: number;
      wordSpacing?: number;
      lineSpacing?: number;
      textAlign?: string;
      textCase?: string;
      italic?: boolean;
      underline?: boolean;
      strikethrough?: boolean;
    };
    styleControls?: Array<{
      id: string;
      type: string;
      default?: string | number | boolean;
      unit?: string;
      valueOn?: string;
      valueOff?: string;
      options?: Array<{ value: string | number | boolean; cssValue?: string }>;
    }>;
  };
}

// NB: vite proxy forwards /api /files /ws to 3131 — BASE stays empty so build works both dev and prod
const BASE = "";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = (await r.json()) as T & { ok?: boolean; error?: string };
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status} ${url}`);
  return body;
}

export async function uploadVideo(file: File, dir?: "uploads" | "bgm") {
  // server expects raw octet-stream, not multipart — see server.mjs /api/upload
  const r = await fetch(`${BASE}/api/upload?name=${encodeURIComponent(file.name)}${dir === "bgm" ? "&dir=bgm" : ""}`, {
    method: "POST",
    body: file,
    headers: { "Content-Type": "application/octet-stream" },
  });
  const j = (await r.json()) as { ok: boolean; videoPath?: string; name?: string; error?: string };
  if (!r.ok || !j.ok || !j.videoPath) throw new Error(j.error || `upload failed for ${file.name}`);
  return { videoPath: j.videoPath, name: j.name || file.name };
}

export interface RunPayload {
  videoPath: string;
  model?: string;
  prompt?: string;
  chunk?: boolean | number;
  stretch?: number;
  hzoom?: number;
  speedMin?: number; // batas lambat tempo (default 0.5)
  speedMax?: number; // batas cepat tempo (default 2)
  caption?: boolean;
  template?: string;
  lead?: number;
  tail?: number;
  outputMode?: "one" | "auto" | "manual";
  parts?: number;
  minutesPerPart?: number;
  targetMinutes?: number;
  bgm?: string;
  bgmDir?: string; // folder pustaka musik -> 1 file random per run
  overlayMode?: "none" | "image" | "css";
  overlayImage?: string;
  overlayHtml?: string;
  overlayCss?: string;
  colorGrade?: "normal" | "cinematic" | "warm" | "cool" | "vivid" | "vintage" | "dramatic" | "random";
  voiceRef?: string; // base64 audio WAV for voice cloning
  ttsModel?: string; // TTS model id (default: env TTS_MODEL atau higgs-tts-q4)
  language?: string; // TTS/Whisper language (default: "Indonesian")
  whisperQuality?: "tiny" | "base" | "small" | "medium";
  resumeJob?: string; // id job lama -> analysis dilewati, pakai manifest-nya
}

export async function runPipeline(p: RunPayload) {

  const j = await jsonFetch<{ ok: boolean; jobId: string; error?: string }>(`${BASE}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p),
  });
  if (!j.ok || !j.jobId) throw new Error(j.error || `run failed for ${p.videoPath}`);
  return { jobId: j.jobId };
}

export async function previewFrame(p: { videoPath: string; stretch?: number; hzoom?: number; atSec?: number }) {
  const j = await jsonFetch<{ ok: boolean; image?: string; atSec?: number; error?: string }>(`${BASE}/api/preview-frame`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p),
  });
  if (!j.ok || !j.image) throw new Error(j.error || "preview gagal");
  return { image: j.image, atSec: j.atSec };
}

export async function addBgm(p: { jobId: string; musicPath?: string; musicDir?: string; level?: number }) {
  const j = await jsonFetch<{ ok: boolean; name?: string; picked?: string; error?: string }>(`${BASE}/api/add-bgm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p),
  });
  if (!j.ok || !j.name) throw new Error(j.error || "add-bgm gagal");
  return { name: j.name, picked: j.picked };
}

export const getJobs = async () => (await jsonFetch<{ ok: boolean; jobs: JobsListItem[] }>(`${BASE}/api/jobs`)).jobs || [];
export const getJob = async (id: string) => (await jsonFetch<{ ok: boolean; job: Job }>(`${BASE}/api/jobs/${encodeURIComponent(id)}`)).job;
export const getJobLog = async (id: string) => (await jsonFetch<{ ok: boolean; log: JobLogEntry[] }>(`${BASE}/api/jobs/${encodeURIComponent(id)}/log`)).log || [];
export const getTemplates = async () => (await jsonFetch<{ ok: boolean; templates: TemplateMeta[] }>(`${BASE}/api/templates`)).templates || [];

export async function cancelJob(id: string) {
  const j = await jsonFetch<{ ok: boolean; error?: string }>(`${BASE}/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  if (!j.ok) throw new Error(j.error || `cancel failed for ${id}`);
}

// HACK: encodeURIComponent turns "/" into %2F but server expects real "/" in /files/:id/<path>
export function fileUrl(jobId: string, name: string) {
  return `${BASE}/files/${encodeURIComponent(jobId)}/${encodeURIComponent(name).replace(/%2F/g, "/")}`;
}

export interface OverlayTemplate {
  id: string;
  name: string;
  description: string;
  html: string;
  css: string;
  created_at: string;
  updated_at: string;
}

export async function getOverlayTemplates() {
  const j = await jsonFetch<{ ok: boolean; templates: OverlayTemplate[] }>(`${BASE}/api/overlay-templates`);
  return j.templates || [];
}

export async function saveOverlayTemplate(payload: { id?: string; name: string; description?: string; html: string; css: string }) {
  const url = payload.id ? `${BASE}/api/overlay-templates/save` : `${BASE}/api/overlay-templates`;
  const method = payload.id ? "POST" : "POST";
  const body = payload.id ? JSON.stringify({ ...payload }) : JSON.stringify(payload);
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body });
  const j = (await r.json()) as { ok: boolean; error?: string; id?: string };
  if (!r.ok || !j.ok) throw new Error(j.error || `save failed ${r.status}`);
  return { ok: true, id: j.id || payload.id };
}

export async function deleteOverlayTemplate(id: string) {
  const j = await jsonFetch<{ ok: boolean; error?: string }>(`${BASE}/api/overlay-templates/${id}`, { method: "DELETE" });
  return j.ok;
}

export async function loadOverlayTemplate(id: string): Promise<OverlayTemplate | null> {
  try {
    const j = await jsonFetch<{ ok: boolean; template: OverlayTemplate }>(`${BASE}/api/overlay-templates/${id}`);
    return j.template ?? null;
  } catch { return null; }
}

export type WsMessage = { type: "log"; jobId: string; entry: JobLogEntry } | { type: "status"; jobId: string; status: JobStatus; stage: JobStage };

export function connectJobWS(
  jobId: string,
  h: {
    onLog?: (e: JobLogEntry) => void;
    onStatus?: (s: JobStatus, st: JobStage) => void;
    onOpen?: () => void;
    onClose?: () => void;
    onError?: (e: Event) => void;
  },
) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws?job=${encodeURIComponent(jobId)}`);
  ws.onopen = () => h.onOpen?.();
  ws.onclose = () => h.onClose?.();
  ws.onerror = (e) => h.onError?.(e);
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data) as WsMessage;
      if (m.type === "log") h.onLog?.(m.entry);
      else if (m.type === "status") h.onStatus?.(m.status, m.stage);
    } catch {
      // non-JSON heartbeat — ignore
    }
  };
  return () => {
    try {
      ws.close();
    } catch {}
  };
}
