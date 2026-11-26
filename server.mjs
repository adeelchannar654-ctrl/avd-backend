// All Video Downloader — standalone backend API (draft, not deployed).
// Mirrors the Vercel site's behaviour in src/lib/yt-dlp.ts so the site only
// needs repointing: POST /analyze and POST /download with the same inputs.
// Node standard library only — no npm dependencies to install.
// Requires: yt-dlp (latest, pip), ffmpeg, Node >= 20, and the bgutil POT
// provider running on 127.0.0.1:4416 (see start.sh). Cookies come from the
// COOKIES_FILE_CONTENT env var, decoded to /tmp/avd-cookies.txt by start.sh.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 10000);
const COOKIES_PATH = '/tmp/avd-cookies.txt';
// Optional shared secret: the Vercel site sends it as x-avd-backend-key so
// the backend is not an open public downloader. Set the same value in both.
const BACKEND_KEY = (process.env.BACKEND_KEY || '').trim();

const VIDEO_FORMATS = {
  'video-highest': 'bestvideo*+bestaudio/best',
  'video-1080p': 'bestvideo*[height<=1080]+bestaudio/best[height<=1080]/best',
  'video-720p': 'bestvideo*[height<=720]+bestaudio/best[height<=720]/best',
  'video-480p': 'bestvideo*[height<=480]+bestaudio/best[height<=480]/best',
  'video-360p': 'bestvideo*[height<=360]+bestaudio/best[height<=360]/best',
};
const ALLOWED_FORMATS = new Set([...Object.keys(VIDEO_FORMATS),
  'audio-128kbps', 'audio-192kbps', 'audio-320kbps']);

function validateUrl(input) {
  const parsed = new URL(String(input || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.')) {
    throw new Error('Only public HTTP and HTTPS video URLs are supported.');
  }
  return parsed.toString();
}

function cookiesArgs() {
  return fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
}

function runYtDlp(args, { timeoutMs = 45_000, maxBuffer = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { timeout: timeoutMs, maxBuffer });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseError(stderr) {
  const msg = String(stderr || '');
  if (/sign in|login required|cookies/i.test(msg)) {
    return 'This media requires login or cookies and cannot be downloaded by this server.';
  }
  if (/not a bot|bot verification/i.test(msg)) return 'The platform blocked this server with bot verification.';
  if (/private video/i.test(msg)) return 'This video is private and cannot be downloaded.';
  if (/drm/i.test(msg)) return 'DRM-protected media cannot be downloaded.';
  if (/video unavailable|media is unavailable|has been removed/i.test(msg)) return 'This media is unavailable or has been removed.';
  if (/unsupported url|no suitable extractor/i.test(msg)) return 'This URL is not supported by the downloader.';
  const line = msg.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('ERROR:')).at(-1);
  return (line ? line.replace(/^ERROR:\s*/, '') : 'The downloader could not process this URL.').slice(0, 500);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
}

async function handleAnalyze(body) {
  const url = validateUrl(body.url);
  const { stdout, stderr, code } = await runYtDlp([
    url, '--dump-single-json', '--skip-download', '--no-playlist',
    '--socket-timeout', '20', '--extractor-retries', '2', '--retries', '2',
    '--no-warnings', '--js-runtimes', 'node', ...cookiesArgs(),
  ]);
  if (code !== 0) throw new Error(parseError(stderr));
  const meta = JSON.parse(stdout);
  const heights = new Set((meta.formats || [])
    .filter((f) => f.vcodec !== 'none' && Number.isFinite(f.height)).map((f) => f.height));
  const atLeast = (h) => [...heights].some((a) => a >= h);
  return {
    title: meta.title || 'Untitled video',
    uploader: meta.uploader || meta.channel || 'Unknown',
    duration: meta.duration || 0,
    view_count: meta.view_count || 0,
    thumbnail: meta.thumbnail || '',
    upload_date: meta.upload_date || '',
    width: meta.width || 0,
    height: meta.height || 0,
    availableQualities: {
      '360p': atLeast(360), '480p': atLeast(480), '720p': atLeast(720),
      '1080p': atLeast(1080), highest: heights.size > 0,
    },
  };
}

async function handleDownload(body, res) {
  const url = validateUrl(body.url);
  const format = String(body.format || '');
  if (!ALLOWED_FORMATS.has(format)) throw new Error('Unsupported download format.');
  const title = String(body.title || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 160) || 'video';
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'avd-'));
  const outTemplate = path.join(dir, 'download.%(ext)s');
  const isAudio = format.startsWith('audio-');
  const args = [url, '--newline', '--no-playlist', '--socket-timeout', '20',
    '--extractor-retries', '2', '--retries', '2', '--no-warnings',
    '--js-runtimes', 'node', '--output', outTemplate, ...cookiesArgs()];
  if (isAudio) {
    const bitrate = format.replace('audio-', '').replace('kbps', '');
    args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', `${bitrate}K`);
  } else {
    args.push('--format', VIDEO_FORMATS[format], '--merge-output-format', 'mp4');
  }
  const { stderr, code } = await runYtDlp(args, { timeoutMs: 5 * 60_000 });
  if (code !== 0) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(parseError(stderr));
  }
  const files = await fs.promises.readdir(dir);
  const file = files.find((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'));
  if (!file) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error('The downloader finished without producing a file.');
  }
  const filePath = path.join(dir, file);
  const ext = path.extname(file).toLowerCase();
  const types = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime' };
  const stats = await fs.promises.stat(filePath);
  res.writeHead(200, {
    'content-type': types[ext] || 'application/octet-stream',
    'content-length': stats.size,
    'content-disposition': `attachment; filename="${encodeURIComponent(title + ext)}"`,
  });
  fs.createReadStream(filePath).pipe(res)
    .on('finish', () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      return sendJson(res, 200, { ok: true, service: 'avd-backend', potProvider: '127.0.0.1:4416', cookies: fs.existsSync(COOKIES_PATH) });
    }
    if (req.method !== 'POST' || !['/analyze', '/download'].includes(req.url)) {
      return sendJson(res, 404, { error: 'Not found.' });
    }
    if (BACKEND_KEY && req.headers['x-avd-backend-key'] !== BACKEND_KEY) {
      return sendJson(res, 401, { error: 'Unauthorized.' });
    }
    const body = await readBody(req);
    if (req.url === '/analyze') return sendJson(res, 200, await handleAnalyze(body));
    return await handleDownload(body, res);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 422, { error: err.message || 'The downloader could not process this URL.' });
  }
});

server.listen(PORT, () => console.log(`avd-backend listening on ${PORT}`));
