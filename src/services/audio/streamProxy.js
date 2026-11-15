// Resolve playable audio URLs through the optional yt-dlp Python package.
const { spawn } = require('child_process');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);

const streamCache = new Map();
const pendingStreams = new Map();
const CACHE_TTL_MS = 45 * 60 * 1000;
const CACHE_LIMIT = 200;
const EXTRACTION_TIMEOUT_MS = 30_000;

function runExtractor(command, target) {
  return new Promise((resolve, reject) => {
    const script = [
      'import json, sys, yt_dlp',
      'opts = {"format": "bestaudio[ext=m4a]/bestaudio", "quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True, "socket_timeout": 15}',
      'with yt_dlp.YoutubeDL(opts) as ydl:',
      ' info = ydl.extract_info(sys.argv[1], download=False)',
      ' if "entries" in info: info = next((item for item in info["entries"] if item), {})',
      ' print(json.dumps({"url": info.get("url"), "duration": info.get("duration"), "title": info.get("title"), "thumbnail": info.get("thumbnail"), "ext": info.get("ext")}))',
    ].join('\n');
    const child = spawn(command, ['-c', script, target], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      settled = true;
      reject(new Error('YouTube ses bağlantısı zaman aşımına uğradı.'));
    }, EXTRACTION_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(
          new Error(
            error.code === 'ENOENT'
              ? 'Python bulunamadı. Python 3 ve yt-dlp kurun (npm run setup:python).'
              : error.message
          )
        );
      }
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(
          new Error(
            /No module named ['"]yt_dlp/.test(stderr)
              ? 'yt-dlp Python paketi kurulu değil. Çalıştırın: npm run setup:python'
              : stderr.trim() || 'YouTube ses bağlantısı alınamadı.'
          )
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (!parsed.url) throw new Error('Ses URL adresi yanıtta yok.');
        resolve(parsed);
      } catch (error) {
        reject(new Error(`YouTube yanıtı çözümlenemedi: ${error.message}`));
      }
    });
  });
}

async function getDirectAudioUrl(queryOrId, { forceRefresh = false } = {}) {
  const query = String(queryOrId || '').trim();
  if (!query || query.length > 500) throw new Error('Arama sorgusu boş veya çok uzun.');
  const cacheKey = query.toLowerCase();
  const cached = streamCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
  if (cached) streamCache.delete(cacheKey);
  if (pendingStreams.has(cacheKey)) return pendingStreams.get(cacheKey);

  const isId = /^[a-zA-Z0-9_-]{11}$/.test(query);
  const target = isId ? `https://www.youtube.com/watch?v=${query}` : `ytsearch1:${query}`;
  const request = (async () => {
    let result;
    try {
      result = await runExtractor(process.env.SUNIFY_PYTHON || 'python', target);
    } catch (error) {
      if (process.env.SUNIFY_PYTHON) throw error;
      result = await runExtractor('py', target);
    }
    if (streamCache.size >= CACHE_LIMIT) streamCache.delete(streamCache.keys().next().value);
    streamCache.set(cacheKey, { timestamp: Date.now(), data: result });
    return result;
  })();
  pendingStreams.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (pendingStreams.get(cacheKey) === request) pendingStreams.delete(cacheKey);
  }
}

async function getRuntimeStatus() {
  const candidates = [process.env.SUNIFY_PYTHON, 'python', 'py'].filter(Boolean);
  for (const executable of candidates) {
    try {
      const isPyLauncher = executable === 'py';
      const args = isPyLauncher
        ? ['-3', '-c', 'import yt_dlp; print("ok")']
        : ['-c', 'import yt_dlp; print("ok")'];
      const { stdout } = await execFile(executable, args, { windowsHide: true, timeout: 5000 });
      if (stdout.trim() === 'ok') return { python: true, ytDlp: true, executable };
    } catch {}
  }
  let pythonAvailable = false;
  for (const executable of candidates) {
    try {
      await execFile(executable, executable === 'py' ? ['-3', '--version'] : ['--version'], { windowsHide: true, timeout: 3000 });
      pythonAvailable = true;
      break;
    } catch {}
  }
  return { python: pythonAvailable, ytDlp: false, executable: null };
}

module.exports = { getDirectAudioUrl, getRuntimeStatus };
