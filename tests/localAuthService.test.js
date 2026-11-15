const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const auth = require('../src/services/auth/localAuthService');

const dbFile = path.join(__dirname, '../data/sunify_users.json');
const originalDb = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;

test.beforeEach(() => fs.writeFileSync(dbFile, '[]', 'utf8'));
test.after(() => {
  if (originalDb) fs.writeFileSync(dbFile, originalDb);
  else if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
});

test('registers with salted scrypt and issues an opaque verifiable session', () => {
  const session = auth.registerUser('Test User', 'test@example.com', 'long-test-password');
  const users = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  assert.equal(users[0].passwordSalt.length, 32);
  assert.notEqual(users[0].passwordHash, 'long-test-password');
  assert.equal(auth.getUserIdForToken(session.access_token), session.user.id);
  assert.equal(auth.getUserIdForToken('local_session_forged'), null);
});

test('rejects duplicate accounts, weak passwords, and revokes sessions', () => {
  const session = auth.registerUser('', 'test@example.com', 'long-test-password');
  assert.throws(() => auth.registerUser('', 'test@example.com', 'long-test-password'));
  assert.throws(() => auth.registerUser('', 'other@example.com', '123'));
  assert.equal(auth.revokeSession(session.access_token), true);
  assert.equal(auth.getUserIdForToken(session.access_token), null);
});

test('upgrades legacy SHA-256 passwords after successful login', () => {
  const crypto = require('crypto');
  fs.writeFileSync(dbFile, JSON.stringify([{
    id: 'legacy-user', username: 'Legacy', email: 'legacy@example.com',
    passwordHash: crypto.createHash('sha256').update('legacy-password').digest('hex'),
  }]));
  const session = auth.loginUser('legacy@example.com', 'legacy-password');
  const user = JSON.parse(fs.readFileSync(dbFile, 'utf8'))[0];
  assert.ok(user.passwordSalt);
  assert.equal(auth.getUserIdForToken(session.access_token), 'legacy-user');
});
