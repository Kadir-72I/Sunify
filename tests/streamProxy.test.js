const test = require('node:test');
const assert = require('node:assert/strict');
const { getDirectAudioUrl, getRuntimeStatus } = require('../src/services/audio/streamProxy');

test('reports whether the optional Python audio engine is ready', async () => {
  const status = await getRuntimeStatus();
  assert.equal(typeof status.python, 'boolean');
  assert.equal(typeof status.ytDlp, 'boolean');
});

test('rejects empty or unreasonably large audio lookup queries', async () => {
  await assert.rejects(getDirectAudioUrl('  '), /boş veya çok uzun/i);
  await assert.rejects(getDirectAudioUrl('x'.repeat(501)), /boş veya çok uzun/i);
});
