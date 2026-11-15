// supabaseClient.js - Sunify Bulut Hesap & Senkronizasyon Servisi
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.SUNIFY_SUPABASE_CONFIG_FILE || path.join(__dirname, '../../../data/supabase_config.json');
const BUNDLED_CONFIG_FILE = path.join(__dirname, '../../../data/supabase_config.json');

let supabase = null;
let currentConfig = {
  url: '',
  anonKey: '',
};

// Kayıtlı config varsa yükle
function loadConfig() {
  try {
    const sourceFile = fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : BUNDLED_CONFIG_FILE;
    if (fs.existsSync(sourceFile)) {
      const raw = fs.readFileSync(sourceFile, 'utf-8');
      currentConfig = JSON.parse(raw);
      if (currentConfig.url && currentConfig.anonKey) {
        supabase = createClient(currentConfig.url, currentConfig.anonKey);
      }
    }
  } catch (err) {
    console.error('Supabase config okuma hatası:', err.message);
  }
}

loadConfig();

function saveConfig(url, anonKey) {
  const parsedUrl = new URL(url.trim());
  if (parsedUrl.protocol !== 'https:' || !anonKey.trim()) {
    throw new Error('Geçerli HTTPS Supabase URL ve anon key gereklidir.');
  }
  currentConfig = { url: parsedUrl.toString().replace(/\/$/, ''), anonKey: anonKey.trim() };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf-8');
  if (currentConfig.url && currentConfig.anonKey) {
    supabase = createClient(currentConfig.url, currentConfig.anonKey);
  }
}

function getSupabase() {
  return supabase;
}

function getSupabaseForToken(accessToken) {
  if (!supabase || !currentConfig.url || !currentConfig.anonKey || typeof accessToken !== 'string' || !accessToken) {
    return null;
  }
  return createClient(currentConfig.url, currentConfig.anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function isConfigured() {
  return !!(supabase && currentConfig.url && currentConfig.anonKey);
}

module.exports = {
  getSupabase,
  getSupabaseForToken,
  isConfigured,
  saveConfig,
  currentConfig,
};
