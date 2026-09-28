# AlurCeritaFilm

AI Movie Recap / Short Generator — ubah film panjang jadi video vertikal 9:16
bernarasikan Bahasa Indonesia, lengkap dengan caption gaya karaoke.

Alur: **VLM analysis** (deteksi momen penting per chunk) → **TTS voice-clone**
(narasi Patrick) → **render FFmpeg 1080x1920** → **caption tscaps + SRT**.

## Arsitektur

```
Studio Web (React/Vite) ──HTTP──▶ API :3131 (Docker) ──▶ VLM gateway (host :20128)
                                            ──▶ audiocpp_server TTS (host :8080)
                                            ──▶ FFmpeg + Chromium caption (dalam container)
```

Stage pipeline: `analysis` (VLM) → `tts` → `render` → `caption`.
Mode `captionOnly` tersedia untuk caption ulang tanpa memanggil AI
(anti rate-limit).

## Prasyarat

| Komponen | Lokasi | Keterangan |
|---|---|---|
| Docker Desktop | host | build + run container |
| Node 20+ & npm | host | sekali saja: build frontend |
| VLM gateway OpenAI-compatible | host `:20128` | analisis video (model `ag/gemini-3.6-flash-high`) |
| `audiocpp_server` (Higgs Audio v3) | host `:8080` | TTS voice-clone, model `omnivoice` |
| File model TTS | `D:/compare/models/OmniVoice-GGUF/omnivoice-q8_0.gguf` | didaftarkan di `server.json` audiocpp |

## Setup (dari nol)

```bash
# 1. Konfigurasi Docker (JANGAN commit file ini — berisi API key)
cp .env.docker.example .env.docker
# lalu isi: OPENAI_BASE_URL, OPENAI_API_KEY, TTS_MODEL, HOST_DATA_DIR, PORT

# 2. Build frontend (sekali saja — dist/ di-COPY ke image)
npm --prefix studio/web install
npm run build

# 3. Build + jalankan
docker build -t movie2short:linux .
docker compose up -d

# 4. Cek API
curl http://localhost:3131/api/jobs
```

Config penting di `.env.docker`:

```
OPENAI_BASE_URL=http://host.docker.internal:20128/v1
OPENAI_API_KEY=<key gateway>
MODEL_NAME=ag/gemini-3.6-flash-high
AUDIOCPP_SERVER=http://host.docker.internal:8080
TTS_MODEL=omnivoice
AUDIOCPP_VOICE_REF=/app/data/reference/patrick_ref_voice.wav
HOST_DATA_DIR=E:/project/movie2short/data
PORT=3131
```

## Audio C++ (TTS server)

1. `audiocpp_server.exe --config server.json` (atau `start_server.bat`).
2. `server.json` minimal:
```json
{
  "host": "127.0.0.1", "port": 8080,
  "models": [{ "id": "omnivoice", "family": "omnivoice",
                "path": "D:/compare/models/OmniVoice-GGUF", "task": "tts" }]
}
```
3. Server hanya melayani model yang terdaftar di `server.json` — id lain
   ditolak `500 unknown model id`.
4. Voice clone butuh pasangan file: `<nama>.wav` + transkrip pendamping
   `<nama>.txt` (isi HARUS sama persis dengan audio). Pipeline otomatis
   memakai `.txt` di sebelah `.wav`; override via `--ref-text`.
   Contoh: `src/patrick_ref_voice.wav` + `src/patrick_ref_voice.txt`.
5. Ganti model TTS: via env `TTS_MODEL`, per-job via UI Studio
   (dropdown TTS Model) atau API (`ttsModel` di `/api/run`).

## Operasi (API ONLY)

```bash
# Upload video → { videoPath }
curl -X POST --data-binary @film.mp4 "http://localhost:3131/api/upload?name=film.mp4"

# Full job → { jobId }
curl -X POST http://localhost:3131/api/run \
  -H "Content-Type: application/json" \
  -d '{"videoPath":"/app/data/uploads/film.mp4","voiceRef":"/app/src/patrick_ref_voice.wav"}'

# Caption ulang tanpa AI → { jobId }
curl -X POST http://localhost:3131/api/run \
  -H "Content-Type: application/json" \
  -d '{"videoPath":"/app/data/output/jobs/<id>/final_short.mp4","captionOnly":true}'

# Status / log / batal
curl http://localhost:3131/api/jobs/<jobId>
curl http://localhost:3131/api/jobs/<jobId>/log
curl -X POST http://localhost:3131/api/jobs/<jobId>/cancel
```

Artifact per job di `data/output/jobs/<jobId>/`:
`final_short.mp4`, `final_captioned_<tpl>.mp4`, `final_captioned_<tpl>.srt`,
`manifest.json`, `narasi.txt`, `narration_audiocpp_natural.wav`.

## Gaya Narasi

Diatur di `src/prompts/narration_prompt.md` (boleh diubah): recap baku,
deskriptif, kronologis, tanpa slang, hook premis langsung di chunk pertama.

## Kredit

- Caption engine + template oleh **tscaps** — https://github.com/francozanardi/tscaps
  (`packages/engine` + `templates/`, lisensi MIT, oleh Franco Zanardi).
  Proyek ini memakai `@tscaps/engine` (vendored di `docker/vendor/`) dan
  template bawaannya sebagai basis caption.
- TTS server oleh **audio.cpp** — https://github.com/0xShug0/audio.cpp
  (framework inferensi audio C++ di atas ggml; `audiocpp_server` = HTTP API
  OpenAI-compatible untuk TTS/voice-clone seperti Higgs Audio v3 dan OmniVoice).

## Lisensi

GPL-3.0-only — lihat `LICENSE`.
