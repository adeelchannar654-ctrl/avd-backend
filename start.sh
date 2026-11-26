#!/bin/sh
# Start the POT provider first (port 4416), then the download API.
# The provider must be up before the first yt-dlp call; yt-dlp finds it at
# the default http://127.0.0.1:4416 with no extra extractor arguments.
set -e

# Cookies: same base64 value already in Vercel as COOKIES_FILE_CONTENT.
# Written to /tmp with 0600, exactly like src/lib/yt-dlp.ts does on Vercel.
if [ -n "$COOKIES_FILE_CONTENT" ]; then
  echo "$COOKIES_FILE_CONTENT" | base64 -d > /tmp/avd-cookies.txt 2>/dev/null \
    || echo "WARN: COOKIES_FILE_CONTENT is not valid base64; continuing without cookies"
  chmod 600 /tmp/avd-cookies.txt 2>/dev/null || true
fi

cd /app/pot-server
PORT=4416 node build/main.js &
POT_PID=$!

# Wait for the provider to answer before starting the API.
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:4416/" 2>/dev/null; then break; fi
  sleep 1
done

cd /app
exec node server.mjs
