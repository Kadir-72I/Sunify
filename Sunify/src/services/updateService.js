const axios = require('axios');
const buildInfo = require('../build-info.json');

function compareVersions(left, right) {
  const parse = (value) => String(value || '').replace(/^v/i, '').split(/[+-]/)[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

async function getLatestRelease(currentVersion, supabaseConfig = null) {
  const repository = String(process.env.SUNIFY_GITHUB_REPOSITORY || buildInfo.repository || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    return { configured: false, currentVersion, updateAvailable: false };
  }

  let release;
  try {
    const response = await axios.get(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sunify-Desktop' },
      timeout: 10_000,
    });
    release = response.data;
  } catch (error) {
    // Private repositories are resolved through the Supabase function; the GitHub token stays server-side.
    if (!supabaseConfig?.url || !supabaseConfig?.anonKey) throw error;
    const response = await axios.post(`${supabaseConfig.url}/functions/v1/sunify-admin`, { action: 'latest-release' }, {
      headers: {
        apikey: supabaseConfig.anonKey,
        Authorization: `Bearer ${supabaseConfig.anonKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    });
    release = response.data;
  }
  const version = String(release.tag_name || '').replace(/^v/i, '');
  const asset = (release.assets || []).find((item) => /\.exe$/i.test(item.name));
  const privateReleaseDownload = release.assetId
    ? `${supabaseConfig.url}/functions/v1/sunify-admin?action=download-release&assetId=${encodeURIComponent(release.assetId)}`
    : null;
  return {
    configured: true,
    currentVersion,
    version,
    title: String(release.name || `Sunify ${version}`).slice(0, 160),
    notes: String(release.body || '').slice(0, 8000),
    releaseUrl: release.html_url,
    downloadUrl: privateReleaseDownload || asset?.browser_download_url || null,
    updateAvailable: Boolean(version && compareVersions(version, currentVersion) > 0),
    publishedAt: release.published_at || null,
  };
}

module.exports = { getLatestRelease };
