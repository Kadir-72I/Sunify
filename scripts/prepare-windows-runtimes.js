const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const runtimeDir = path.join(root, 'build', 'runtime');

async function requestJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Sunify-Desktop-Builder', Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub release metadata request failed (${response.status}): ${url}`);
  return response.json();
}

async function downloadVerified(asset, destination, allowedHosts) {
  if (!asset.digest?.startsWith('sha256:')) throw new Error(`GitHub did not provide a SHA-256 digest for ${asset.name}.`);
  const assetUrl = new URL(asset.browser_download_url);
  if (assetUrl.protocol !== 'https:' || !allowedHosts.includes(assetUrl.hostname)) {
    throw new Error(`Unexpected release asset URL for ${asset.name}.`);
  }
  const response = await fetch(assetUrl);
  if (!response.ok) throw new Error(`Could not download ${asset.name} (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const expected = asset.digest.slice('sha256:'.length).toLowerCase();
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`SHA-256 verification failed for ${asset.name}.`);
  await fs.writeFile(destination, bytes);
}

async function findFile(directory, fileName) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return fullPath;
    if (entry.isDirectory()) {
      const found = await findFile(fullPath, fileName);
      if (found) return found;
    }
  }
  return null;
}

async function downloadLicense(tag, repository, fileName) {
  const url = `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(tag)}/${fileName}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Sunify-Desktop-Builder' } });
  if (!response.ok) throw new Error(`Could not retrieve third-party license: ${repository}/${fileName} (${response.status}).`);
  return response.text();
}

async function main() {
  if (process.platform !== 'win32') throw new Error('The self-contained installer build currently targets Windows x64.');
  await fs.mkdir(runtimeDir, { recursive: true });

  const [ytDlpRelease, denoRelease] = await Promise.all([
    requestJson('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'),
    requestJson('https://api.github.com/repos/denoland/deno/releases/latest'),
  ]);
  const ytDlpAsset = ytDlpRelease.assets.find((asset) => asset.name === 'yt-dlp.exe');
  const denoAsset = denoRelease.assets.find((asset) => /^deno-x86_64-pc-windows-msvc\.zip$/i.test(asset.name));
  if (!ytDlpAsset || !denoAsset) throw new Error('Could not find the official yt-dlp.exe and Windows x64 Deno release assets.');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sunify-runtime-'));
  try {
    const ytDlpPath = path.join(runtimeDir, 'yt-dlp.exe');
    const denoZipPath = path.join(tempDir, denoAsset.name);
    const denoExtractDir = path.join(tempDir, 'deno');
    await Promise.all([
      downloadVerified(ytDlpAsset, ytDlpPath, ['github.com']),
      downloadVerified(denoAsset, denoZipPath, ['github.com']),
    ]);
    await fs.mkdir(denoExtractDir, { recursive: true });
    await fs.mkdir(denoExtractDir, { recursive: true });
    await require('node:child_process').execFileSync('tar.exe', ['-xf', denoZipPath, '-C', denoExtractDir], {
      windowsHide: true,
      stdio: 'pipe',
    });
    const denoExe = await findFile(denoExtractDir, 'deno.exe');
    if (!denoExe) throw new Error('Deno release archive did not contain deno.exe.');
    await fs.copyFile(denoExe, path.join(runtimeDir, 'deno.exe'));

    const [ytDlpLicense, denoLicense] = await Promise.all([
      downloadLicense(ytDlpRelease.tag_name, 'yt-dlp/yt-dlp', 'LICENSE'),
      downloadLicense(denoRelease.tag_name, 'denoland/deno', 'LICENSE.md'),
    ]);
    const notice = [
      'Sunify third-party runtime notices',
      `yt-dlp ${ytDlpRelease.tag_name} (Windows standalone executable)`,
      'Source: https://github.com/yt-dlp/yt-dlp',
      ytDlpLicense.trim(),
      '',
      `Deno ${denoRelease.tag_name} (Windows x64 runtime)`,
      'Source: https://github.com/denoland/deno',
      denoLicense.trim(),
      '',
    ].join('\n');
    await fs.writeFile(path.join(runtimeDir, 'THIRD-PARTY-NOTICES.txt'), notice, 'utf8');
    console.log(`Prepared verified yt-dlp ${ytDlpRelease.tag_name} and Deno ${denoRelease.tag_name} runtimes.`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Windows runtime preparation failed: ${error.message}`);
  process.exitCode = 1;
});
