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

  const ytDlpRelease = await requestJson('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');
  const ytDlpAsset = ytDlpRelease.assets.find((asset) => asset.name === 'yt-dlp_win.zip');
  if (!ytDlpAsset) throw new Error('Could not find the official unpackaged yt-dlp Windows x64 zip release asset.');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sunify-runtime-'));
  try {
    const ytDlpZipPath = path.join(tempDir, ytDlpAsset.name);
    const ytDlpExtractDir = path.join(tempDir, 'yt-dlp-extracted');
    const ytDlpStagingDir = path.join(tempDir, 'yt-dlp');
    await downloadVerified(ytDlpAsset, ytDlpZipPath, ['github.com']);
    await fs.mkdir(ytDlpExtractDir, { recursive: true });
    require('node:child_process').execFileSync('tar.exe', ['-xf', ytDlpZipPath, '-C', ytDlpExtractDir], {
      windowsHide: true,
      stdio: 'pipe',
    });
    const ytDlpExe = await findFile(ytDlpExtractDir, 'yt-dlp.exe');
    if (!ytDlpExe) throw new Error('yt-dlp Windows archive did not contain yt-dlp.exe.');
    const ytDlpInternal = path.join(path.dirname(ytDlpExe), '_internal');
    const internalStat = await fs.stat(ytDlpInternal).catch(() => null);
    if (!internalStat?.isDirectory()) throw new Error('yt-dlp Windows archive did not contain its _internal runtime directory.');
    await fs.mkdir(ytDlpStagingDir, { recursive: true });
    await fs.copyFile(ytDlpExe, path.join(ytDlpStagingDir, 'yt-dlp.exe'));
    await fs.cp(ytDlpInternal, path.join(ytDlpStagingDir, '_internal'), { recursive: true });

    const ytDlpRuntimeDir = path.join(runtimeDir, 'yt-dlp');
    const previousYtDlpRuntimeDir = path.join(runtimeDir, `yt-dlp.previous-${process.pid}`);
    let movedPrevious = false;
    try {
      await fs.rename(ytDlpRuntimeDir, previousYtDlpRuntimeDir);
      movedPrevious = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.rename(ytDlpStagingDir, ytDlpRuntimeDir);
    } catch (error) {
      if (movedPrevious) await fs.rename(previousYtDlpRuntimeDir, ytDlpRuntimeDir).catch(() => {});
      throw error;
    }
    if (movedPrevious) await fs.rm(previousYtDlpRuntimeDir, { recursive: true, force: true });

    // Remove legacy 115 MB deno.exe if present
    await fs.rm(path.join(runtimeDir, 'deno.exe'), { force: true }).catch(() => {});

    const ytDlpLicense = await downloadLicense(ytDlpRelease.tag_name, 'yt-dlp/yt-dlp', 'LICENSE');
    const notice = [
      'Sunify third-party runtime notices',
      `yt-dlp ${ytDlpRelease.tag_name} (Windows unpackaged x64 executable with _internal runtime)`,
      'Source: https://github.com/yt-dlp/yt-dlp',
      ytDlpLicense.trim(),
      '',
    ].join('\n');
    await fs.writeFile(path.join(runtimeDir, 'THIRD-PARTY-NOTICES.txt'), notice, 'utf8');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  console.log(`Prepared bundled Windows runtime in ${runtimeDir}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
