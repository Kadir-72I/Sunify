// streamProxy.js
// Ultra Hızlı Python yt-dlp Motoru (Önbellek & Fast Extract)
const { spawn } = require('child_process');

// RAM Önbelleği (Aynı şarkı tekrar çalındığında 0 milisaniyede açılır)
const streamCache = new Map();

function getDirectAudioUrl(queryOrId) {
  const cacheKey = String(queryOrId).trim().toLowerCase();
  if (streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    // URL'nin süresi geçmemişse doğrudan RAM'den döndür
    if (Date.now() - cached.timestamp < 1000 * 60 * 60 * 3) {
      return Promise.resolve(cached.data);
    }
  }

  return new Promise((resolve, reject) => {
    const isId = /^[a-zA-Z0-9_-]{11}$/.test(queryOrId);
    const target = isId ? `https://www.youtube.com/watch?v=${queryOrId}` : `ytsearch1:${queryOrId}`;

    // Hız için optimize edilmiş Python komutu:
    // Sadece m4a format 140'ı (YouTube 128kbps AAC) hedefler, format taramasını pas geçer!
    const pyProcess = spawn('python', [
      '-c',
      `
import sys, yt_dlp
target = sys.argv[1]
ydl_opts = {
    'format': '140/bestaudio[ext=m4a]/bestaudio',
    'quiet': True,
    'no_warnings': True,
    'skip_download': True,
    'extract_flat': False,
    'noplaylist': True,
    'socket_timeout': 5
}
try:
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(target, download=False)
        if 'entries' in info and info['entries']:
            info = info['entries'][0]
        url = info.get('url', '')
        duration = info.get('duration', 0)
        title = info.get('title', '')
        thumbnail = info.get('thumbnail', '')
        print(f"{url}|||{duration}|||{title}|||{thumbnail}")
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
      `,
      target,
    ]);

    let output = '';
    let errorOutput = '';

    pyProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    pyProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    pyProcess.on('close', (code) => {
      if (code === 0 && output.trim()) {
        const parts = output.trim().split('|||');
        const result = {
          url: parts[0],
          duration: parseFloat(parts[1]) || 0,
          title: parts[2] || '',
          thumbnail: parts[3] || '',
        };

        // Önbelleğe kaydet
        streamCache.set(cacheKey, { timestamp: Date.now(), data: result });
        resolve(result);
      } else {
        reject(new Error(errorOutput || 'Audio stream alınamadı'));
      }
    });
  });
}

module.exports = { getDirectAudioUrl };
