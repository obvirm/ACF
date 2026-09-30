# movie2short — Linux runtime
# Base: mcr.microsoft.com/playwright (sudah ada Chromium + ffmpeg + deps).
# Frontend: build di host (studio/web/dist/), Docker hanya COPY.

FROM mcr.microsoft.com/playwright:v1.49.0-noble

ENV DEBIAN_FRONTEND=noninteractive \
    PORT=3131 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TSCAPS_TEMPLATES_DIR=/app/src/templates \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=30000 \
    npm_config_fetch_retry_maxtimeout=120000

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg wget gnupg \
 && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -rf /var/lib/apt/lists/* /tmp/chrome.deb

WORKDIR /app

# --- root deps (server + pipeline) ---
COPY package.json package-lock.json .npmrc ./
COPY docker/vendor ./docker/vendor
RUN npm ci --omit=dev=false --no-audit --no-fund \
 && npm install --no-save --no-audit --no-fund @rolldown/binding-linux-x64-gnu@1.2.8

# --- Whisper ONNX (caption tscaps) — salin dari image lama (offline, cepat).
# Jaringan HF ke sini ~0.1 MB/s, download 400MB = 50+ menit & sering hang.
# Machine baru tanpa image lama: ganti COPY --from dengan RUN wget (ada di git history).
COPY --from=movie2short:linux /root/.cache/huggingface/hub /root/.cache/huggingface/hub
# Guard: kalau file kurang, unduh dengan timeout (gak hang tanpa batas).
RUN EN=/root/.cache/huggingface/hub/models--onnx-community--whisper-medium_timestamped/snapshots/default/onnx/encoder_model_quantized.onnx \
 && DEC=/root/.cache/huggingface/hub/models--onnx-community--whisper-medium_timestamped/snapshots/default/onnx/decoder_model_merged_quantized.onnx \
 && if [ ! -f "$EN" ] || [ ! -f "$DEC" ]; then \
      cd "$(dirname "$EN")" && \
      wget -q -T 30 -t 3 "https://huggingface.co/onnx-community/whisper-medium_timestamped/resolve/main/onnx/encoder_model_quantized.onnx" && \
      wget -q -T 30 -t 3 "https://huggingface.co/onnx-community/whisper-medium_timestamped/resolve/main/onnx/decoder_model_merged_quantized.onnx"; \
    fi

# --- frontend: build di host, tinggal COPY dist ---
COPY studio/web/dist ./studio/web/dist

# --- source backend/pipeline ---
COPY src ./src

# --- entrypoint ---
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /app/data/uploads /app/data/output/jobs

EXPOSE 3131

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server/server.mjs"]
