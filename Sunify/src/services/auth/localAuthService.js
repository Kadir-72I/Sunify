// Local account storage and opaque session tokens for offline use.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = process.env.SUNIFY_USER_DB_FILE || path.join(__dirname, '../../../data/sunify_users.json');
const SESSION_PREFIX = 'local_session_';
const PASSWORD_SCRYPT_N = 16384;

function readUsers() {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    const users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(users)) throw new Error('Kullanıcı veritabanı biçimi geçersiz.');
    return users;
  } catch (error) {
    throw new Error(`Kullanıcı veritabanı okunamadı: ${error.message}`);
  }
}

function writeUsers(users) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tempFile = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(users, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempFile, DB_FILE);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.scryptSync(password, salt, 64, { N: PASSWORD_SCRYPT_N }).toString('hex'),
  };
}

function verifyPassword(user, password) {
  if (user.passwordSalt && user.passwordHash) {
    const actual = crypto.scryptSync(password, user.passwordSalt, 64, { N: PASSWORD_SCRYPT_N });
    const expected = Buffer.from(user.passwordHash, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  }
  // One-way legacy compatibility: a successful login upgrades the old unsalted SHA-256 record.
  if (user.passwordHash && !user.passwordSalt) {
    const actual = crypto.createHash('sha256').update(password).digest();
    const expected = Buffer.from(user.passwordHash, 'hex');
    if (expected.length === actual.length && crypto.timingSafeEqual(actual, expected)) {
      const upgraded = hashPassword(password);
      user.passwordSalt = upgraded.salt;
      user.passwordHash = upgraded.hash;
      return true;
    }
  }
  return false;
}

function createSession(user) {
  const token = SESSION_PREFIX + crypto.randomBytes(32).toString('hex');
  const users = readUsers();
  const currentUser = users.find((item) => item.id === user.id);
  if (!currentUser) throw new Error('Hesap bulunamadı.');
  currentUser.sessionTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  writeUsers(users);
  return {
    access_token: token,
    token_type: 'bearer',
    user: {
      id: user.id,
      email: user.email,
      user_metadata: { username: user.username },
    },
  };
}

function registerUser(username, email, password) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new Error('Geçerli bir e-posta adresi girin.');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw new Error('Şifre 8 ile 256 karakter arasında olmalıdır.');
  }
  const users = readUsers();
  const normalizedEmail = email.trim().toLowerCase();
  if (users.some((user) => user.email?.toLowerCase() === normalizedEmail)) {
    throw new Error('Bu e-posta adresiyle zaten bir hesap var.');
  }
  const credentials = hashPassword(password);
  const user = {
    id: `usr_${crypto.randomUUID()}`,
    username: (typeof username === 'string' ? username.trim() : '').slice(0, 60) || normalizedEmail.split('@')[0],
    email: normalizedEmail,
    passwordSalt: credentials.salt,
    passwordHash: credentials.hash,
    created_at: new Date().toISOString(),
    playlists: [],
    likedTracks: [],
    listeningStats: {},
  };
  users.push(user);
  writeUsers(users);
  return createSession(user);
}

function loginUser(email, password) {
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new Error('E-posta veya şifre hatalı.');
  }
  const users = readUsers();
  const normalizedEmail = email.trim().toLowerCase();
  const user = users.find((item) => item.email?.toLowerCase() === normalizedEmail);
  if (!user || !verifyPassword(user, password)) throw new Error('E-posta veya şifre hatalı.');
  writeUsers(users);
  return createSession(user);
}

function getUserData(userId) {
  const user = readUsers().find((item) => item.id === userId);
  if (!user) return null;
  return {
    playlists: user.playlists || [],
    analytics: { liked_tracks: user.likedTracks || [], listening_stats: user.listeningStats || {} },
  };
}

function saveUserData(userId, { playlists, likedTracks, listeningStats }) {
  const users = readUsers();
  const user = users.find((item) => item.id === userId);
  if (!user) return false;
  if (playlists !== undefined) user.playlists = playlists;
  if (likedTracks !== undefined) user.likedTracks = likedTracks;
  if (listeningStats !== undefined) user.listeningStats = listeningStats;
  writeUsers(users);
  return true;
}

function getUserIdForToken(token) {
  if (typeof token !== 'string' || !token.startsWith(SESSION_PREFIX)) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = readUsers().find((item) => item.sessionTokenHash === tokenHash);
  return user?.id || null;
}

function revokeSession(token) {
  const userId = getUserIdForToken(token);
  if (!userId) return false;
  const users = readUsers();
  const user = users.find((item) => item.id === userId);
  delete user.sessionTokenHash;
  writeUsers(users);
  return true;
}

function deleteUserAccount(token, password) {
  const userId = getUserIdForToken(token);
  if (!userId) throw new Error('Yerel oturum geçersiz veya süresi bitmiş.');
  if (typeof password !== 'string' || !password) throw new Error('Hesap şifresi gerekli.');
  const users = readUsers();
  const userIndex = users.findIndex((item) => item.id === userId);
  if (userIndex < 0 || !verifyPassword(users[userIndex], password)) throw new Error('Şifre doğrulanamadı.');
  const [deleted] = users.splice(userIndex, 1);
  writeUsers(users);
  return { id: deleted.id, email: deleted.email };
}

function deleteLocalAccountForEmail(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const users = readUsers();
  const userIndex = users.findIndex((item) => item.email?.toLowerCase() === normalizedEmail);
  // Called only after the cloud deletion endpoint has authenticated the same email.
  if (userIndex < 0) return false;
  users.splice(userIndex, 1);
  writeUsers(users);
  return true;
}

module.exports = { registerUser, loginUser, getUserData, saveUserData, getUserIdForToken, revokeSession, deleteUserAccount, deleteLocalAccountForEmail };
