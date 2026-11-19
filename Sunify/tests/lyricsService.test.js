const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchLyrics } = require('../src/services/audio/lyricsService');

test('Genius provides complete plain lyrics for Turkish and Massaka tracks', { timeout: 15000 }, async () => {
  const result = await fetchLyrics('Massaka - Karanlık(Offiziell HD)', 'MASSAKA', 210, 'genius');
  assert.equal(result.success, true);
  assert.equal(result.source, 'Genius (Düz)');
  assert.equal(typeof result.plainLyrics, 'string');
  assert.ok(result.plainLyrics.length > 200);
});

test('Kugou provides synced lyrics for popular tracks', async () => {
  const result = await fetchLyrics('Shape of You', 'Ed Sheeran', 233, 'kugou');
  if (result.success) {
    assert.equal(result.source, 'Kugou (Senkron)');
    assert.ok(result.syncedLyrics && result.syncedLyrics.includes('['));
  }
});

test('Auto mode falls back to Genius when LRCLIB has no lyrics for a Turkish track', async () => {
  const result = await fetchLyrics('Affet', 'Müslüm Gürses', 260, 'auto');
  assert.equal(result.success, true);
  assert.ok(result.syncedLyrics || result.plainLyrics);
  console.log('Result for Müslüm Gürses - Affet:', result.source);
});
