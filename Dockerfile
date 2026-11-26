# All Video Downloader — standalone yt-dlp backend (draft, not deployed)
# Prepared 2026-11-22 after the Vercel cookies fix AND the latest-yt-dlp update
# both failed live (analyze still extractionLimited, download still HTTP 422).
# Vercel is closed as a download host: it cannot run the always-on PO-token
# provider YouTube now demands, and its shared datacenter IPs are flagged.
#
# What this is: one Docker container that runs, together:
#   1. bgutil POT provider HTTP server (Node, port 4416, default — the plugin
#      finds it with no extra extractor args)
#   2. yt-dlp (latest from pip) + the bgutil POT plugin (pip)
#   3. ffmpeg
#   4. server.mjs — a tiny API mirroring the Vercel site's analyze/download
#      behaviour, so the Vercel site only needs repointing, not rewriting.
#
# Platform-agnostic by design: the same image runs on Render (free, to prove
# it), Railway, or the Oracle VPS. No platform choice is baked in.
# NOTHING here contains cookies. COOKIES_FILE_CONTENT is an env var only,
# set in the host dashboard — never committed, never pasted in chat.

FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    POT_PROVIDER_PORT=4416 \
    PORT=10000

# Node 20 (POT provider server + API) and ffmpeg.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg ffmpeg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Latest yt-dlp + the bgutil POT plugin (needs yt-dlp >= 2025.05.22).
RUN pip install --no-cache-dir -U yt-dlp bgutil-ytdlp-pot-provider

WORKDIR /app

# POT provider server source (cloned at build so the version is pinned here).
ARG BGUTIL_VERSION=1.3.0
RUN curl -fsSL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz \
      | tar -xz --strip-components=1 -C /tmp \
    && cp -r /tmp/bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}/server /app/pot-server \
    && rm -rf /tmp/bgutil-ytdlp-pot-provider-${BGUTIL_VERSION} \
    && cd /app/pot-server && npm ci --omit=dev && npx tsc

COPY server.mjs start.sh ./
RUN chmod +x start.sh

# Render free tier: 512 MB RAM. Keep the container lean; no persistent disk.
EXPOSE 10000

CMD ["./start.sh"]
