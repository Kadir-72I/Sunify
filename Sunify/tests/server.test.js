const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('../src/server');

const dbFile = path.join(__dirname, '../data/sunify_users.json');
let originalDb;
let server;
let baseUrl;

test.before(async () => {
  originalDb = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
  fs.writeFileSync(dbFile, '[]', 'utf8');
  server = startServer((port) => { baseUrl = `http://127.0.0.1:${port}`; });
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server?.listening) server.close();
  if (originalDb) fs.writeFileSync(dbFile, originalDb);
  else if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
});

test('binds only to loopback, returns diagnostics, and rejects untrusted origins', async () => {
  assert.equal(server.address().address, '127.0.0.1');
  const diagnostic = await fetch(`${baseUrl}/api/diagnostics`);
  assert.equal(diagnostic.status, 200);
  assert.equal((await diagnostic.json()).server, 'ready');
  const blocked = await fetch(`${baseUrl}/api/diagnostics`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(blocked.status, 403);
});

test('returns bounded JSON errors for malformed API input', async () => {
  const longQuery = await fetch(`${baseUrl}/api/search?q=${'x'.repeat(201)}`);
  assert.equal(longQuery.status, 400);
  assert.match((await longQuery.json()).error, /200 karakter/);

  const longTitle = await fetch(`${baseUrl}/api/lyrics?title=${'x'.repeat(241)}`);
  assert.equal(longTitle.status, 400);
  assert.match((await longTitle.json()).error, /çok uzun/);

  const malformed = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get('content-type')?.includes('application/json'), true);
  assert.equal(typeof (await malformed.json()).error, 'string');
});

test('validates local registration and authenticates sync with opaque sessions', async () => {
  const bad = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.com', password: '123' }),
  });
  assert.equal(bad.status, 400);
  const signup = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sync@example.com', password: 'safe-password' }),
  });
  assert.equal(signup.status, 200);
  const session = (await signup.json()).session;
  const push = await fetch(`${baseUrl}/api/sync/push`, {
    method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ playlists: [], likedTracks: [], listeningStats: {} }),
  });
  assert.equal(push.status, 200);
  const forged = await fetch(`${baseUrl}/api/sync/pull`, { headers: { Authorization: 'Bearer local_session_forged' } });
  assert.equal(forged.status, 401);
  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` },
  });
  assert.equal(logout.status, 200);
  const revoked = await fetch(`${baseUrl}/api/sync/pull`, { headers: { Authorization: `Bearer ${session.access_token}` } });
  assert.equal(revoked.status, 401);
});
