// Resolve playable audio URLs through the optional yt-dlp Python package.
const { spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const execFile = promisify(require('child_process').execFile);

const streamCache = new Map();
const pendingStreams = new Map();
const pendingDownloads = new Map();
const pendingAudioStarts = new Map();
const CACHE_TTL_MS = 45 * 60 * 1000;
const CACHE_LIMIT = 80;
const EXTRACTION_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
// Start playback after the container's initial header is present; the browser
// can keep buffering from the growing file while yt-dlp downloads the rest.
const STREAM_START_BYTES = 4 * 1024;
const AUDIO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let audioCacheMaxBytes = 3 * 1024 * 1024 * 1024;
const AUDIO_FORWARD_HEADERS = new Set(['user-agent', 'accept', 'accept-language', 'sec-fetch-mode', 'referer', 'origin']);
const FAST_YOUTUBE_EXTRACTOR_ARGS = ['--extractor-args', 'youtube:player_client=default,-tv_samsung'];
const MAX_BACKGROUND_DOWNLOADS = 1;
const MAX_QUEUED_BACKGROUND = 2;
const downloadGate = { active: 0, queue: [] };
const queryIdMap = new Map();
let queryIdMapLoaded = false;
let queryResolver = null;
let pendingLowStarts = 0;
let activeExtractions = 0;
function getActiveExtractions() { return activeExtractions; }

function isMissingBinary(error) {
  return error?.code === 'ENOENT' || /spawn .* ENOENT/i.test(String(error?.message || ''));
}

function isTimeoutError(error) {
  return /zaman aşımı|timed out/i.test(String(error?.message || ''));
}

async function withFastFallback(run, beforeRetry) {
  try {
    return await run(true);
  } catch (error) {
    if (isMissingBinary(error) || isTimeoutError(error)) throw error;
    console.warn('[audio] Hızlı YouTube istemcisi başarısız; varsayılan istemci deneniyor:', String(error.message || error).slice(0, 180));
    if (beforeRetry) await beforeRetry();
    return run(false);
  }
}

function releaseDownloadSlot() {
  downloadGate.active = Math.max(0, downloadGate.active - 1);
  while (downloadGate.active < MAX_BACKGROUND_DOWNLOADS && downloadGate.queue.length) {
    const queued = downloadGate.queue.shift();
    downloadGate.active += 1;
    queued.resolve(releaseDownloadSlot);
  }
}

function acquireDownloadSlot(cacheKey, priority = 'low') {
  if (downloadGate.active < MAX_BACKGROUND_DOWNLOADS && downloadGate.queue.length === 0) {
    downloadGate.active += 1;
    return Promise.resolve(releaseDownloadSlot);
  }
  // A direct play request may start immediately while no more than two
  // background downloads are running; queued background work waits behind it.
  if (priority === 'high') {
    downloadGate.active += 1;
    return Promise.resolve(releaseDownloadSlot);
  }
  return new Promise((resolve) => downloadGate.queue.push({ cacheKey, resolve }));
}

function promoteDownload(cacheKey) {
  const index = downloadGate.queue.findIndex((entry) => entry.cacheKey === cacheKey);
  if (index < 0) return false;
  const [entry] = downloadGate.queue.splice(index, 1);
  // A foreground click may briefly exceed the two background worker limit.
  downloadGate.active += 1;
  entry.resolve(releaseDownloadSlot);
  return true;
}

function setQueryResolver(resolver) {
  queryResolver = typeof resolver === 'function' ? resolver : null;
}

function normalizePlaybackQuery(query) {
  return String(query || '').trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ');
}

async function loadQueryIdMap() {
  if (queryIdMapLoaded) return;
  queryIdMapLoaded = true;
  try {
    const data = JSON.parse(await fs.promises.readFile(path.join(getAudioCacheDirectory(), 'sunify-video-id-map.json'), 'utf8'));
    for (const [query, id] of Object.entries(data)) {
      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) queryIdMap.set(query, id);
    }
  } catch {}
}

async function saveQueryIdMap() {
  const directory = getAudioCacheDirectory();
  await fs.promises.mkdir(directory, { recursive: true });
  const entries = [...queryIdMap.entries()].slice(-1500);
  const tempPath = path.join(directory, `sunify-video-id-map.${process.pid}.tmp`);
  const targetPath = path.join(directory, 'sunify-video-id-map.json');
  await fs.promises.writeFile(tempPath, JSON.stringify(Object.fromEntries(entries)), 'utf8');
  await fs.promises.rename(tempPath, targetPath).catch(async () => {
    await fs.promises.unlink(targetPath).catch(() => {});
    await fs.promises.rename(tempPath, targetPath);
  });
}

async function hasCachedOrActiveQuery(query) {
  const target = `ytsearch1:${query}`;
  const cacheKey = crypto.createHash('sha256').update(target).digest('hex');
  if (pendingDownloads.has(cacheKey)) return true;
  const directory = getAudioCacheDirectory();
  const prefix = `sunify-audio-${cacheKey}`;
  const names = await fs.promises.readdir(directory).catch(() => []);
  return names.some((name) => name.startsWith(`${prefix}.`) && (
    name.endsWith('.inprogress') || (!name.endsWith('.part') && !name.endsWith('.json'))
  ));
}

async function resolvePlaybackTarget(query, { preserveLegacyCache = true, excludeVideoIds = [], retrySearch = false } = {}) {
  const input = String(query || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const excluded = new Set((Array.isArray(excludeVideoIds) ? excludeVideoIds : []).map(String));
  if (!retrySearch && !excluded.size && preserveLegacyCache && await hasCachedOrActiveQuery(input)) return input;

  await loadQueryIdMap();
  const key = normalizePlaybackQuery(input);
  const cachedId = queryIdMap.get(key);
  if (retrySearch && cachedId) excluded.add(cachedId);
  if (!retrySearch && cachedId && !excluded.has(cachedId)) return cachedId;
  if (!queryResolver) return input;

  try {
    const resolvedId = String(await queryResolver(input, { excludeVideoIds: [...excluded], forceRefresh: retrySearch }) || '').trim();
    if (!/^[a-zA-Z0-9_-]{11}$/.test(resolvedId)) return input;
    // A retry-specific alternate must not replace the normal query mapping.
    if (!excluded.size) {
      queryIdMap.set(key, resolvedId);
      if (queryIdMap.size > 1500) queryIdMap.delete(queryIdMap.keys().next().value);
      await saveQueryIdMap().catch((error) => console.warn('Parça kimlik eşlemesi kaydedilemedi:', error.message));
    }
    return resolvedId;
  } catch (error) {
    console.warn('Parça kimliği önceden bulunamadı; yt-dlp araması kullanılacak:', error.message);
    return input;
  }
}

function getBundledRuntimePaths() {
  let packaged = false;
  try {
    packaged = Boolean(process.versions.electron && require('electron').app?.isPackaged);
  } catch {}
  const root = packaged
    ? path.join(process.resourcesPath, 'sunify-tools')
    : path.resolve(__dirname, '../../../build/runtime');
  const onedirYtDlp = path.join(root, 'yt-dlp', 'yt-dlp.exe');
  return {
    ytDlp: fs.existsSync(onedirYtDlp) ? onedirYtDlp : path.join(root, 'yt-dlp.exe'),
    deno: path.join(root, 'deno.exe'),
  };
}

function runBundledExtractor(executable, denoPath, target, fast = true) {
  return new Promise((resolve, reject) => {
    const args = [
      '--print', '%(.{url,duration,title,thumbnail,ext,http_headers})j', '--no-warnings', '--no-playlist',
      '--format', 'bestaudio[ext=m4a]/bestaudio', '--skip-download',
      '--socket-timeout', '15', '--no-progress', '--quiet',
      // Google Video signs these URLs to the extractor's egress IP. Keep yt-dlp
      // and the Node audio proxy on IPv4 so the signed URL does not return 403.
      '--force-ipv4',
      '--js-runtimes', `deno:${denoPath}`,
      ...(fast ? FAST_YOUTUBE_EXTRACTOR_ARGS : []),
      target,
    ];
    const child = spawn(executable, args, { windowsHide: true });
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
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(stderr.trim() || 'YouTube ses bağlantısı alınamadı.'));
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

function runExtractor(command, target) {
  return new Promise((resolve, reject) => {
    const script = [
      'import json, sys, yt_dlp',
      'opts = {"format": "bestaudio[ext=m4a]/bestaudio", "quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True, "socket_timeout": 15, "force_ipv4": True}',
      'with yt_dlp.YoutubeDL(opts) as ydl:',
      ' info = ydl.extract_info(sys.argv[1], download=False)',
      ' if "entries" in info: info = next((item for item in info["entries"] if item), {})',
      ' print(json.dumps({"url": info.get("url"), "duration": info.get("duration"), "title": info.get("title"), "thumbnail": info.get("thumbnail"), "ext": info.get("ext"), "http_headers": info.get("http_headers")}))',
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

function getAudioCacheDirectory() {
  return process.env.SUNIFY_AUDIO_CACHE_DIR || path.join(os.tmpdir(), 'SunifyAudioCache');
}

function getAudioTargetCacheKey(target) {
  return crypto.createHash('sha256').update(String(target)).digest('hex');
}

async function writeAudioCacheMetadata(filePath, metadata) {
  if (!filePath || !metadata || !String(metadata.title || '').trim()) return false;
  const safeMetadata = {
    id: String(metadata.id || '').slice(0, 80),
    query: String(metadata.query || '').slice(0, 500),
    title: String(metadata.title || '').trim().slice(0, 240),
    artist: String(metadata.artist || '').trim().slice(0, 200),
    thumbnail: String(metadata.thumbnail || '').slice(0, 2000),
    duration: Math.max(0, Number(metadata.duration) || 0),
  };
  const metaPath = `${filePath}.meta.json`;
  const tempPath = `${metaPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(safeMetadata), 'utf8');
  await fs.promises.rename(tempPath, metaPath).catch(async (error) => {
    await fs.promises.unlink(metaPath).catch(() => {});
    await fs.promises.rename(tempPath, metaPath).catch(() => { throw error; });
  });
  return true;
}

async function getCachedAudioByKey(cacheKey) {
  const key = String(cacheKey || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Önbellek parça anahtarı geçersiz.');
  const directory = getAudioCacheDirectory();
  const prefix = `sunify-audio-${key}.`;
  const names = await fs.promises.readdir(directory).catch(() => []);
  for (const name of names) {
    if (!name.startsWith(prefix) || !/\.(?:m4a|mp3|webm|opus|ogg)$/i.test(name)) continue;
    const filePath = path.join(directory, name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.size < 1024 || fs.existsSync(`${filePath}.inprogress`) || fs.existsSync(`${path.join(directory, `sunify-audio-${key}`)}.inprogress`) || !(await isSupportedAudioFile(filePath))) continue;
    await fs.promises.utimes(filePath, new Date(), new Date()).catch(() => {});
    return { filePath, complete: true, completion: Promise.resolve(filePath), timing: { firstBytesMs: 0 } };
  }
  throw new Error('Bu önbellek parçası artık bulunamıyor.');
}

async function isSupportedAudioFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const handle = await fs.promises.open(filePath, 'r').catch(() => null);
  if (!handle) return false;
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (extension === '.m4a' || extension === '.mp4') return bytesRead >= 12 && header.toString('ascii', 4, 8) === 'ftyp';
    if (extension === '.webm') return bytesRead >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (extension === '.ogg' || extension === '.opus') return bytesRead >= 4 && header.toString('ascii', 0, 4) === 'OggS';
    if (extension === '.mp3') return bytesRead >= 3 && (header.toString('ascii', 0, 3) === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0));
    return false;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function isProgressivelyPlayableAudio(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.m4a') return true;
  const handle = await fs.promises.open(filePath, 'r').catch(() => null);
  if (!handle) return false;
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let offset = 0;
    while (offset + 8 <= bytesRead) {
      let size = buffer.readUInt32BE(offset);
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > bytesRead) return false;
        const largeSize = Number(buffer.readBigUInt64BE(offset + 8));
        if (!Number.isSafeInteger(largeSize) || largeSize < 16) return false;
        size = largeSize;
        headerSize = 16;
      }
      if (type === 'moov') return true;
      if (type === 'mdat' || size === 0 || size < headerSize) return false;
      if (offset + size > bytesRead) return false;
      offset += size;
    }
    return false;
  } finally {
    await handle.close().catch(() => {});
  }
}

function runBundledDownload(executable, denoPath, target, outputTemplate, fast = true) {
  const args = [
    '--no-warnings', '--no-playlist', '--no-progress', '--quiet', '--no-part', '--no-write-info-json', '--no-write-thumbnail',
    '--format', 'bestaudio[ext=m4a]/bestaudio', '--socket-timeout', '20', '--force-ipv4',
    '--output', outputTemplate, '--print', 'after_move:filepath', '--js-runtimes', `deno:${denoPath}`,
    ...(fast ? FAST_YOUTUBE_EXTRACTOR_ARGS : []), target,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      settled = true;
      reject(new Error('YouTube ses indirme işlemi zaman aşımına uğradı.'));
    }, DOWNLOAD_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-16_384); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0) return reject(new Error(stderr.trim() || 'YouTube ses parçası indirilemedi.'));
      resolve(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '');
    });
  });
}

function runPythonDownload(command, target, outputTemplate) {
  const script = [
    'import sys, yt_dlp',
    `opts = {"format": "bestaudio[ext=m4a]/bestaudio", "quiet": True, "no_warnings": True, "noplaylist": True, "nopart": True, "socket_timeout": 20, "force_ipv4": True, "outtmpl": ${JSON.stringify(outputTemplate)}}`,
    'with yt_dlp.YoutubeDL(opts) as ydl:',
    ' info = ydl.extract_info(sys.argv[1], download=True)',
    ' print(ydl.prepare_filename(info))',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const args = command === 'py' ? ['-3', '-c', script, target] : ['-c', script, target];
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      settled = true;
      reject(new Error('YouTube ses indirme işlemi zaman aşımına uğradı.'));
    }, DOWNLOAD_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-16_384); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0) return reject(new Error(stderr.trim() || 'YouTube ses parçası indirilemedi.'));
      resolve(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '');
    });
  });
}

async function pruneAudioCache(directory) {
  const now = Date.now();
  const files = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  const activePrefixes = new Set(files.filter((entry) => entry.isFile() && entry.name.startsWith('sunify-audio-') && entry.name.endsWith('.inprogress')).map((entry) => entry.name.slice(0, -'.inprogress'.length)));
  const entries = [];
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.startsWith('sunify-audio-') || entry.name.endsWith('.part') || entry.name.endsWith('.inprogress') || entry.name.endsWith('.json') || [...activePrefixes].some((prefix) => entry.name === prefix || entry.name.startsWith(`${prefix}.`))) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat) continue;
    if (now - stat.mtimeMs > AUDIO_CACHE_TTL_MS) {
      await fs.promises.unlink(filePath).catch(() => {});
      await fs.promises.unlink(`${filePath}.meta.json`).catch(() => {});
      continue;
    }
    entries.push({ path: filePath, size: stat.size, mtime: stat.mtimeMs });
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= audioCacheMaxBytes) break;
    await fs.promises.unlink(entry.path).catch(() => {});
    await fs.promises.unlink(`${entry.path}.meta.json`).catch(() => {});
    total -= entry.size;
  }
}

function setAudioCacheLimit(limitGB) {
  const value = Number(limitGB);
  if (!Number.isFinite(value) || value < 0) throw new Error('Önbellek sınırı geçersiz.');
  audioCacheMaxBytes = value === 0 ? Infinity : Math.round(value * 1024 * 1024 * 1024);
  return audioCacheMaxBytes;
}

async function getAudioCacheStats() {
  const directory = getAudioCacheDirectory();
  await fs.promises.mkdir(directory, { recursive: true });
  await pruneAudioCache(directory);
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  let bytes = 0;
  let files = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('sunify-audio-') || entry.name.endsWith('.part') || entry.name.endsWith('.inprogress') || entry.name.endsWith('.json')) continue;
    const stat = await fs.promises.stat(path.join(directory, entry.name)).catch(() => null);
    if (stat?.isFile()) { bytes += stat.size; files += 1; }
  }
  return { directory, bytes, files, limitBytes: audioCacheMaxBytes === Infinity ? 0 : audioCacheMaxBytes };
}

async function clearAudioCache() {
  const directory = getAudioCacheDirectory();
  await fs.promises.mkdir(directory, { recursive: true });
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  const activePrefixes = new Set(entries.filter((entry) => entry.isFile() && entry.name.startsWith('sunify-audio-') && entry.name.endsWith('.inprogress')).map((entry) => entry.name.slice(0, -'.inprogress'.length)));
  let bytes = 0;
  let files = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('sunify-audio-')) continue;
    if ([...activePrefixes].some((prefix) => entry.name === prefix || entry.name.startsWith(`${prefix}.`)) || entry.name.endsWith('.part') || entry.name.endsWith('.inprogress')) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    await fs.promises.unlink(filePath);
    bytes += stat.size;
    files += 1;
  }
  return { bytes, files, activeDownloadsSkipped: activePrefixes.size };
}

async function listCachedAudioFiles(knownTracks = []) {
  const directory = getAudioCacheDirectory();
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  await loadQueryIdMap();
  const metadataByKey = new Map();
  const addTrack = (track, target) => {
    if (!target) return;
    const key = getAudioTargetCacheKey(target);
    if (!metadataByKey.has(key)) metadataByKey.set(key, {
      id: track.videoId || track.id || '',
      query: track.query || `${track.artist || ''} ${track.title || ''}`.trim(),
      title: track.title || '',
      artist: track.artist || '',
      thumbnail: track.thumbnail || '',
      duration: Number(track.duration) || 0,
    });
  };
  for (const track of (Array.isArray(knownTracks) ? knownTracks : []).slice(0, 800)) {
    if (!track?.title) continue;
    const videoId = String(track.videoId || track.youtubeId || track.id || '').trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(videoId)) addTrack(track, `https://www.youtube.com/watch?v=${videoId}`);
    const query = String(track.query || `${track.artist || ''} ${track.title}`).trim();
    if (query) {
      addTrack(track, `ytsearch1:${query}`);
      const resolvedId = queryIdMap.get(normalizePlaybackQuery(query));
      if (resolvedId) addTrack({ ...track, videoId: resolvedId }, `https://www.youtube.com/watch?v=${resolvedId}`);
    }
  }
  for (const [query, videoId] of queryIdMap) {
    const title = query.split(/\s+-\s+/).at(-1) || query;
    addTrack({ title, query, artist: '', videoId }, `https://www.youtube.com/watch?v=${videoId}`);
    addTrack({ title, query, artist: '' }, `ytsearch1:${query}`);
  }
  const tracks = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('sunify-audio-') || /\.(?:part|json)$/.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.size < 1024 || !(await isSupportedAudioFile(filePath))) continue;
    if (Date.now() - stat.mtimeMs > AUDIO_CACHE_TTL_MS) {
      await fs.promises.unlink(filePath).catch(() => {});
      await fs.promises.unlink(`${filePath}.meta.json`).catch(() => {});
      continue;
    }
    const prefix = entry.name.slice(0, entry.name.lastIndexOf('.'));
    if (fs.existsSync(path.join(directory, `${prefix}.inprogress`))) continue;
    let metadata;
    try { metadata = JSON.parse(await fs.promises.readFile(`${filePath}.meta.json`, 'utf8')); } catch {}
    const cacheKey = prefix.replace(/^sunify-audio-/, '');
    metadata ||= metadataByKey.get(cacheKey);
    if (!metadata) metadata = {
      id: '', query: '', title: `Önbelleğe alınan parça ${cacheKey.slice(0, 6).toUpperCase()}`,
      artist: 'Sunify önbelleği', thumbnail: '', duration: 0,
    };
    if (!String(metadata.title || '').trim()) continue;
    if (!fs.existsSync(`${filePath}.meta.json`) && metadataByKey.has(cacheKey)) {
      await writeAudioCacheMetadata(filePath, metadata).catch((error) => console.warn('Önbellek bilgisi geri yüklenemedi:', error.message));
    }
    tracks.push({
      id: String(metadata.id || ''),
      query: String(metadata.query || `${metadata.artist || ''} ${metadata.title}`).trim(),
      title: String(metadata.title).trim(),
      artist: String(metadata.artist || 'Bilinmeyen Sanatçı').trim(),
      thumbnail: String(metadata.thumbnail || ''),
      duration: Number(metadata.duration) || 0,
      cacheSizeBytes: stat.size,
      cachedAt: stat.mtimeMs,
      isCached: true,
      cacheKey,
    });
  }
  return tracks.sort((a, b) => b.cachedAt - a.cachedAt);
}

async function startCachedAudioDownload(queryOrId, { priority = 'high', excludeVideoIds = [], retrySearch = false } = {}) {
  const requested = String(queryOrId || '').trim();
  if (!requested || requested.length > 500) throw new Error('Arama sorgusu boş veya çok uzun.');
  if (!['high', 'low'].includes(priority)) priority = 'high';
  if (priority === 'low') {
    if (pendingLowStarts >= MAX_QUEUED_BACKGROUND) throw new Error('Arka plan hazırlık kuyruğu dolu.');
    pendingLowStarts += 1;
  }
  try {
    return await startResolvedAudioDownload(requested, priority, excludeVideoIds, retrySearch);
  } finally {
    if (priority === 'low') pendingLowStarts = Math.max(0, pendingLowStarts - 1);
  }
}

async function startResolvedAudioDownload(requested, priority, excludeVideoIds = [], retrySearch = false) {
  const query = await resolvePlaybackTarget(requested, {
    preserveLegacyCache: !excludeVideoIds.length && !retrySearch,
    excludeVideoIds,
    retrySearch,
  });
  const startedAt = Date.now();
  const target = /^[a-zA-Z0-9_-]{11}$/.test(query)
    ? `https://www.youtube.com/watch?v=${query}`
    : `ytsearch1:${query}`;
  const cacheKey = crypto.createHash('sha256').update(target).digest('hex');
  if (pendingAudioStarts.has(cacheKey)) {
    if (priority === 'high') promoteDownload(cacheKey);
    return pendingAudioStarts.get(cacheKey);
  }
  const starting = startCachedAudioDownloadUncoalesced(query, priority, cacheKey, target);
  pendingAudioStarts.set(cacheKey, starting);
  try {
    return await starting;
  } finally {
    if (pendingAudioStarts.get(cacheKey) === starting) pendingAudioStarts.delete(cacheKey);
  }
}

async function startCachedAudioDownloadUncoalesced(query, priority, cacheKey, target) {
  const startedAt = Date.now();
  const directory = getAudioCacheDirectory();
  const prefix = `sunify-audio-${cacheKey}`;
  await fs.promises.mkdir(directory, { recursive: true });

  const findCachedFile = async () => {
    const names = await fs.promises.readdir(directory).catch(() => []);
    for (const name of names) {
      if (!name.startsWith(`${prefix}.`) || name.endsWith('.part') || name.endsWith('.json')) continue;
      const filePath = path.join(directory, name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat?.isFile() || stat.size <= 1024 || fs.existsSync(`${filePath}.inprogress`) || fs.existsSync(path.join(directory, `${prefix}.inprogress`))) continue;
      if (!await isSupportedAudioFile(filePath)) {
        if (/\.(?:m4a|mp3|webm|opus|ogg)$/i.test(name)) {
          await fs.promises.unlink(filePath).catch(() => {});
          await fs.promises.unlink(`${filePath}.meta.json`).catch(() => {});
        }
        continue;
      }
      if (stat?.isFile()) {
        await fs.promises.utimes(filePath, new Date(), new Date()).catch(() => {});
        return { filePath, complete: true, completion: Promise.resolve(filePath), timing: { firstBytesMs: 0 } };
      }
    }
    return null;
  };

  const cached = await findCachedFile();
  if (cached) {
    console.info(`[audio-cache] complete cache hit: ${query}`);
    return { ...cached, timing: { firstBytesMs: 0 } };
  }
  if (pendingDownloads.has(cacheKey)) {
    console.info(`[audio-cache] joining active download: ${query}`);
    const task = pendingDownloads.get(cacheKey);
    const filePath = await waitForGrowingAudioFile(directory, prefix, task.completion);
    return { filePath, complete: false, completion: task.completion, timing: { firstBytesMs: Date.now() - startedAt } };
  }

  const outputTemplate = path.join(directory, `${prefix}.%(ext)s`);
  console.info(`[audio-cache] starting progressive download: ${query}`);
  const progressMarker = path.join(directory, `${prefix}.inprogress`);
  if (fs.existsSync(progressMarker)) {
    const staleFiles = await fs.promises.readdir(directory).catch(() => []);
    await Promise.all(staleFiles.filter((name) => name.startsWith(`${prefix}.`)).map((name) => fs.promises.unlink(path.join(directory, name)).catch(() => {})));
  }
  await fs.promises.writeFile(progressMarker, String(Date.now()), 'utf8');
  let releaseSlot = null;
  const download = (async () => {
    const bundled = getBundledRuntimePaths();
    releaseSlot = await acquireDownloadSlot(cacheKey, priority);
    try {
      await withFastFallback(
        (fast) => runBundledDownload(bundled.ytDlp, bundled.deno, target, outputTemplate, fast),
        async () => {
          const partials = await fs.promises.readdir(directory).catch(() => []);
          await Promise.all(partials.filter((name) => name.startsWith(`${prefix}.`) && !name.endsWith('.inprogress')).map((name) => fs.promises.unlink(path.join(directory, name)).catch(() => {})));
        }
      );
    } catch (error) {
      if (!isMissingBinary(error)) throw error;
      let pythonError;
      for (const command of [process.env.SUNIFY_PYTHON, 'python', 'py'].filter(Boolean)) {
        try {
          await runPythonDownload(command, target, outputTemplate);
          pythonError = null;
          break;
        } catch (caught) {
          pythonError = caught;
          if (process.env.SUNIFY_PYTHON) break;
        }
      }
      if (pythonError) throw pythonError;
    }
    await fs.promises.unlink(progressMarker).catch(() => {});
    const completed = await findCachedFile();
    if (!completed) throw new Error('YouTube ses parçası indirildi ancak önbellek dosyası bulunamadı.');
    await pruneAudioCache(directory);
    return completed.filePath;
  })().catch(async (error) => {
    await fs.promises.unlink(progressMarker).catch(() => {});
    const names = await fs.promises.readdir(directory).catch(() => []);
    await Promise.all(names.filter((name) => name.startsWith(`${prefix}.`)).map((name) => fs.promises.unlink(path.join(directory, name)).catch(() => {})));
    throw error;
  }).finally(() => {
    releaseSlot?.();
  });
  const task = { completion: download };
  pendingDownloads.set(cacheKey, task);
  download.finally(() => {
    if (pendingDownloads.get(cacheKey) === task) pendingDownloads.delete(cacheKey);
  }).catch(() => {});
  const filePath = await waitForGrowingAudioFile(directory, prefix, download);
  return { filePath, complete: false, completion: download, timing: { firstBytesMs: Date.now() - startedAt } };
}

async function waitForGrowingAudioFile(directory, prefix, completion) {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const names = await fs.promises.readdir(directory).catch(() => []);
    for (const name of names) {
      if (!name.startsWith(`${prefix}.`) || name.endsWith('.part') || name.endsWith('.json') || name.endsWith('.inprogress')) continue;
      const filePath = path.join(directory, name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (stat?.isFile() && stat.size >= STREAM_START_BYTES) return filePath;
    }
    const settled = await Promise.race([completion.then(() => 'done', () => 'error'), new Promise((resolve) => setTimeout(() => resolve('pending'), 25))]);
    if (settled === 'done') {
      const namesAfter = await fs.promises.readdir(directory).catch(() => []);
      const completePath = namesAfter.find((name) => name.startsWith(`${prefix}.`) && !name.endsWith('.json') && !name.endsWith('.inprogress'));
      if (completePath) return path.join(directory, completePath);
      throw new Error('İndirilen ses dosyası bulunamadı.');
    }
    if (settled === 'error') await completion;
  }
  throw new Error('YouTube ses verisi zamanında gelmedi.');
}

async function getCachedAudioFile(queryOrId) {
  const audio = await startCachedAudioDownload(queryOrId);
  await audio.completion;
  return audio.filePath;
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
    activeExtractions += 1;
    let result;
    const bundled = getBundledRuntimePaths();
    if (process.env.SUNIFY_YTDLP_PATH && process.env.SUNIFY_DENO_PATH) {
      result = await withFastFallback(
        (fast) => runBundledExtractor(process.env.SUNIFY_YTDLP_PATH, process.env.SUNIFY_DENO_PATH, target, fast)
      );
    } else {
      try {
        result = await withFastFallback((fast) => runBundledExtractor(bundled.ytDlp, bundled.deno, target, fast));
      } catch (error) {
        if (error.code !== 'ENOENT' && !/spawn .* ENOENT/i.test(error.message)) throw error;
        try {
          result = await runExtractor(process.env.SUNIFY_PYTHON || 'python', target);
        } catch (pythonError) {
          if (process.env.SUNIFY_PYTHON) throw pythonError;
          result = await runExtractor('py', target);
        }
      }
    }
    if (streamCache.size >= CACHE_LIMIT) streamCache.delete(streamCache.keys().next().value);
    streamCache.set(cacheKey, { timestamp: Date.now(), data: result });
    return result;
  })().finally(() => { activeExtractions = Math.max(0, activeExtractions - 1); });
  pendingStreams.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (pendingStreams.get(cacheKey) === request) pendingStreams.delete(cacheKey);
  }
}

async function getRuntimeStatus() {
  const bundled = getBundledRuntimePaths();
  try {
    const [{ stdout: ytDlpVersion }, { stdout: denoVersion }] = await Promise.all([
      execFile(bundled.ytDlp, ['--version'], { windowsHide: true, timeout: 5000 }),
      execFile(bundled.deno, ['--version'], { windowsHide: true, timeout: 5000 }),
    ]);
    if (ytDlpVersion.trim() && denoVersion.trim()) {
      return { python: false, ytDlp: true, deno: true, bundled: true, executable: bundled.ytDlp };
    }
  } catch {}
  if (fs.existsSync(bundled.ytDlp) || fs.existsSync(bundled.deno)) {
    return { python: false, ytDlp: false, deno: fs.existsSync(bundled.deno), bundled: true, executable: bundled.ytDlp };
  }

  const candidates = [process.env.SUNIFY_PYTHON, 'python', 'py'].filter(Boolean);
  for (const executable of candidates) {
    try {
      const isPyLauncher = executable === 'py';
      const args = isPyLauncher
        ? ['-3', '-c', 'import yt_dlp; print("ok")']
        : ['-c', 'import yt_dlp; print("ok")'];
      const { stdout } = await execFile(executable, args, { windowsHide: true, timeout: 5000 });
      if (stdout.trim() === 'ok') return { python: true, ytDlp: true, deno: false, bundled: false, executable };
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
  return { python: pythonAvailable, ytDlp: false, deno: false, bundled: false, executable: null };
}

// yt-dlp and Deno both have a cold-start cost; warm them once in the background.
function warmUp() {
  const { ytDlp, deno } = getBundledRuntimePaths();
  for (const [executable, args] of [[ytDlp, ['--version']], [deno, ['--version']]]) {
    if (!fs.existsSync(executable)) continue;
    try {
      const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => {});
    } catch {}
  }
}

module.exports = { getDirectAudioUrl, getCachedAudioFile, getCachedAudioByKey, writeAudioCacheMetadata, isProgressivelyPlayableAudio, startCachedAudioDownload, listCachedAudioFiles, getAudioCacheDirectory, getAudioCacheStats, clearAudioCache, setAudioCacheLimit, getRuntimeStatus, getActiveExtractions, getQueuedDownloads: () => pendingLowStarts, setQueryResolver, warmUp };

