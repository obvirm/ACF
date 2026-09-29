# movie2short - Project Context

## Aturan Struktur (WAJIB)
- Semua kode HANYA di `src/` (backend+pipeline) atau `studio/` (frontend).
- DILARANG bikin direktori/file kode baru di root. Root hanya: `src/`, `studio/`, `data/`, `docker/`, config (`package.json`, `Dockerfile`, `docker-compose.yml`, `.env*`, `.dockerignore`, `AGENTS.md`).
- Nama file/variabel simpel, tanpa prefix doktrin (`M2S_`, `movie2short-`, dsb).

## Directory Structure
```
movie2short/
├── src/                    # Backend + pipeline
│   ├── server/server.mjs   # API server (port 3131)
│   ├── server/db.mjs       # SQLite via sql.js
│   ├── server/analyze.ts
│   ├── tts/tts.mjs         # TTS orchestration (HTTP ke audiocpp_server)
│   ├── analyzer/           # VLM analysis (model.ts, frameExtractor, audioExtractor)
│   ├── synthesizer/split.ts # Manifest splitting
│   ├── renderer/overlay.mjs # Playwright overlay (screenshot PNG)
│   ├── renderer/fonts.css
│   ├── caption/            # Caption renderer (render.ts, template.ts/html, fonts.css, public/)
│   └── prompts/            # LLM prompts
├── studio/                 # Frontend
│   └── web/                # React/Vite app → build → studio/web/dist/
├── data/                   # Runtime data (DB, uploads, output jobs)
├── docker/                 # entrypoint.sh
├── .env                    # Windows config
├── .env.docker             # Docker config
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Input Video
- **Video input utama**: `C:\Users\X\Downloads\getvid.mp4`
- **Video referensi** (gaya narasi): `C:\Users\X\Downloads\KISAH SPONGEBOB JADI PENGANGGURAN.mp4`
- JANGAN menukar keduanya. Video referensi hanya untuk gaya, BUKAN input pipeline.
## Voice Clone — Dok audio C++ Adalah Ketuhanan
- WAJIB ikut `audio.cpp/app/server/README.md` penuh. Format request: `voice_ref: {type:"base64",data}` (atau `{type:"path",path}`) + `reference_text` (transkrip SAMA PERSIS isi audio ref).
- DILARANG aturan custom: tidak ada aturan detik/durasi/nama file voice. File ref = pilihan user, gonta-ganti untuk tes.
- Konvensi pasangan: `<nama>.wav` + `<nama>.txt` satu basename (contoh: `patrick_ref.wav` + `patrick_ref.wav.txt`). Pipeline auto-pakai `.txt` pendamping; override via `--ref-text`.
- Ref saat ini (boleh diganti user kapan pun): `data/reference/patrick_ref.wav`.

## Pipeline Architecture
1. **Analyzer** (`src/analyzer/` via `src/server/analyze.ts`): VLM analysis per chunk via OpenAI Compatible API → manifest + narration.
2. **Synthesizer** (`src/synthesizer/split.ts`): Split manifest ke parts.
3. **TTS** (`src/tts/tts.mjs`): HTTP call ke `audiocpp_server` on host → narration wav.
4. **Renderer** (`src/renderer/` + `src/index.ts --only-render`): FFmpeg + Playwright overlay → final video.
5. **Caption** (`src/caption/render.ts` + `@tscaps/engine`): Chromium headless render SRT → `final_captioned_<tpl>.mp4`. Butuh Chrome asli (H.264) di Docker — chromium Playwright tidak bisa decode H.264.

## Deployment — Docker ONLY
- **TIDAK ada host server**. Pipeline berjalan 100% di Docker.
- Build: `docker build -t movie2short:linux .`
- Run: `docker compose up -d`
- Port: 3131
- Frontend: build di host (`npm run build` → `studio/web/dist/`), Docker COPY.

## TTS — HTTP API Only
- `audiocpp_server` (Higgs Audio v3) berjalan di HOST, bukan di Docker.
- Pipeline memanggil via HTTP: `POST http://host.docker.internal:8080/v1/audio/speech`
- Voice cloning = `voice_ref: {type:"path",path}` (host path via `HOST_DATA_DIR`) + `reference_text`. Base64 ditolak server bila >5 MiB.
- Model TTS default: `omnivoice` (600+ bahasa, voice clone). File model: `D:\compare\models\OmniVoice-GGUF\omnivoice-q8_0.gguf`.
- Config host: `E:\Ai\audiocpp\server.json` → model id `omnivoice`.
- Config `.env.docker`: `AUDIOCPP_SERVER`, `AUDIOCPP_VOICE_REF`, `TTS_MODEL`, `HOST_DATA_DIR`.
- **TIDAK ada** `audiocpp_cli`, `tts/bin/`, `models/` di repo. Semua di host.

## VLM API Gateway
- Gateway berjalan di host: `http://localhost:20128/v1`
- Config di `.env`:
  - `OPENAI_BASE_URL=http://localhost:20128/v1`
  - `OPENAI_API_KEY=sk-bdce2f8bda4f930c-utjako-ab5e1326`
  - `MODEL_NAME=ag/gemini-3.6-flash-high`
- **Gateway HARUS aktif** sebelum pipeline jalan. Kalau mati, analysis gagal.

## Database (SQLite)
- File: `data/movie2short.db` (sql.js, pure JS/WASM)
- Auto-flush ke disk tiap 5 detik.
- Tables: `jobs`, `job_artifacts`, `job_logs`, `scenes`.

## Operasi — API ONLY (WAJIB)
- SEMUA operasi pipeline HANYA via Studio HTTP API (`http://localhost:3131`):
  - `POST /api/upload?name=<file>` (body: bytes video) → `{ videoPath }`
  - `POST /api/run` `{ videoPath, model, outputMode }` → `{ jobId }`
  - `GET /api/jobs/:id` → status/stage/log/artifacts
  - `GET /api/jobs/:id/log` → detail log (filter `level: "err"`)
  - `POST /api/jobs/:id/cancel` → batalkan job stuck
- DILARANG shortcut CLI untuk operasi pipeline: `docker exec node ...`, `npx tsx src/...`, run script pipeline langsung, `curl`-bypass, dsb.
- SATU-SATUNYA CLI yang boleh: menyalakan API server dev (`npm run dev:ui`). Setelah server nyala, kembali ke API.
- `src/index.ts` BUKAN CLI standalone — worker render yang dipanggil server (`src/server/server.mjs:421`). Jangan hapus.
- CLI TTS lama (`src/tts/audiocpp_manifest_tts.mjs`) sudah DIHAPUS — TTS hanya via `src/tts/tts.mjs` lewat API.

## Run Command (Development — Windows)
```
node src/server/server.mjs
```
Atau: `npm run dev:ui`

## Aturan Kerja (WAJIB)
- **JANGAN SENTUH BACKEND KALAU USER CUMA MINTA FRONTEND/UI.**
- **JANGAN OVER-ENGINEERING.** YAGNI — kerjakan tepat yang diminta.
- **Jangan commit/push tanpa perintah eksplisit user.**
- **Jangan eksekusi perintah destruktif git** tanpa arahan user.
- **File tester/sementara WAJIB dihapus saat itu juga.** Tidak boleh ada sisa/bercak di repo, data user, atau folder mana pun.
- **Thinking kelamaan = kabari user.**

## Hirarki Interaksi (WAJIB)
### 1. Tanya Jawab Dulu, Action Nanti
- Kalau user **nanya** → **jawab dulu**. Jangan langsung ngoding, grep, commit, atau action apa pun.
- Kalau user **nyuruh** → baru kerjakan sesuai permintaan.
- Kalau ambigu → **tanya balik** "Mau saya ...?" sebelum action.
- Contoh, larangan, atau keluhan BUKAN perintah edit. Edit hanya bila ada kata eksplisit: "minta", "tambah", "ubah", "perbaiki", "kerjakan", "gas", "commit", "push". Tanpa itu → jawab saja.
- Perintah "running job" tanpa jenis = ambigu. Wajib tanya dulu: full / captionOnly / add-bgm / preview — sebelum submit apa pun.
- DILARANG asumsi: videoPath, jobId, nama file, dan isi folder WAJIB dicek (log/dir/API) dulu sebelum dipakai. Asumsi = pelanggaran.

### 2. Jawab Singkat, Tidak Berbelit
- Jawaban langsung, tidak perlu panjang. User bisa tanya lanjutan kalau butuh detail.
- Jangan kasih contoh kasus, flow diagram, atau commit history kecuali diminta.
- Jangan nawarin "mau saya revert?" atau "lanjut?" setelah jawab — tunggu user nyuruh.

### 3. Dilarang Overstep
- **DILARANG** nge-grep, ngebaca file, atau ngocol source code cuma buat "membuktikan" jawaban.
- **DILARANG** nge-commit, ngedit, atau nerima perubahan tanpa request eksplisit.
- **DILARANG** nambahin fitur, config, atau aturan yang tidak diminta.

## Aturan Anti-Mereh (WAJIB)
- **JANGAN jawab iya-iya tanpa bukti.** Sertakan `file:line`.
- **DI plan cuma boleh read/inspect.**
- **DI build jangan eksekusi tanpa `ok` eksplisit user.**

## Aturan Timeout & Anti-Hang (WAJIB)
- SEMUA perintah yang bisa gantung WAJIB timeout eksplisit. Tidak ada perintah tanpa batas.
- DILARANG start server + test dalam 1 perintah (output streaming mengunci call). Pola wajib: start detached + redirect output → verifikasi/poll di perintah terpisah.
- Download besar WAJIB resume (`curl -C -`, retry terbatas). Dilarang transfer raksasa sekali jalan tanpa resume.
- Polling WAJIB bounded (N iterasi × sleep) — dilarang loop tanpa akhir.
- Call yang lewat timeout TANPA output = abort + lapor. Dilarang ulang buta perintah yang sama.
- Operasi >10 mnt (build, download GB, convert model) WAJIB dipecah jadi tahap cekpoin, lapor tiap tahap.

## Known Issues / Env
- C: drive mudah penuh (pagefile 16-30 GB; RAM host 31,8 GB).
- Ollama kadang mati dan perlu restart.
- Jangan commit/push tanpa perintah eksplisit user.
