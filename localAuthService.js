// localAuthService.js - Sunify Yerel & Bulut Hibrit Hesap Motoru
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, '../../../data/sunify_users.json');

function readUsers() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Kullanıcı veritabanı okuma hatası:', e.message);
  }
  return [];
}

function writeUsers(users) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2), 'utf-8');
  } catch (e) {
    console.error('Kullanıcı veritabanı yazma hatası:', e.message);
  }
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function registerUser(username, email, password) {
  const users = readUsers();
  const normalizedEmail = email.trim().toLowerCase();

  const existing = users.find((u) => u.email.toLowerCase() === normalizedEmail);
  if (existing) {
    throw new Error('Bu e-posta adresiyle zaten bir hesap var.');
  }

  const userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const newUser = {
    id: userId,
    username: username.trim() || normalizedEmail.split('@')[0],
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    created_at: new Date().toISOString(),
    playlists: [],
    likedTracks: [],
    listeningStats: {},
  };

  users.push(newUser);
  writeUsers(users);

  // Oturum objesi (Supabase auth session uyumlu)
  return {
    access_token: 'local_token_' + userId + '_' + Date.now(),
    user: {
      id: newUser.id,
      email: newUser.email,
      user_metadata: { username: newUser.username },
    },
  };
}

function loginUser(email, password) {
  const users = readUsers();
  const normalizedEmail = email.trim().toLowerCase();
  const hash = hashPassword(password);

  const user = users.find(
    (u) => u.email.toLowerCase() === normalizedEmail && u.passwordHash === hash
  );
  if (!user) {
    throw new Error('E-posta veya şifre hatalı.');
  }

  return {
    access_token: 'local_token_' + user.id + '_' + Date.now(),
    user: {
      id: user.id,
      email: user.email,
      user_metadata: { username: user.username },
    },
  };
}

function getUserData(userId) {
  const users = readUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return null;
  return {
    playlists: user.playlists || [],
    analytics: {
      liked_tracks: user.likedTracks || [],
      listening_stats: user.listeningStats || {},
    },
  };
}

function saveUserData(userId, { playlists, likedTracks, listeningStats }) {
  const users = readUsers();
  const idx = users.findIndex((u) => u.id === userId);
  if (idx === -1) return false;

  if (playlists) users[idx].playlists = playlists;
  if (likedTracks) users[idx].likedTracks = likedTracks;
  if (listeningStats) users[idx].listeningStats = listeningStats;

  writeUsers(users);
  return true;
}

module.exports = {
  registerUser,
  loginUser,
  getUserData,
  saveUserData,
};
