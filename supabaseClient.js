// supabaseClient.js - Sunify Bulut Hesap & Senkronizasyon Servisi
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../../../data/supabase_config.json');

let supabase = null;
let currentConfig = {
  url: '',
  anonKey: '',
};

// Kayıtlı config varsa yükle
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
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
  currentConfig = { url: url.trim(), anonKey: anonKey.trim() };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf-8');
  if (currentConfig.url && currentConfig.anonKey) {
    supabase = createClient(currentConfig.url, currentConfig.anonKey);
  }
}

function getSupabase() {
  return supabase;
}

function isConfigured() {
  return !!(supabase && currentConfig.url && currentConfig.anonKey);
}

module.exports = {
  getSupabase,
  isConfigured,
  saveConfig,
  currentConfig,
};
