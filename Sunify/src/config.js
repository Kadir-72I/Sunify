// src/config.js
const path = require('path');
const pkg = require('../package.json');

module.exports = {
  PORT: process.env.PORT || 3001,
  API_BASE: 'http://localhost:3001/api',
  DEFAULT_THEME: 'dark',
  APP_NAME: 'Sunify',
  VERSION: pkg.version || '1.0.1',
  DATA_DIR: process.env.SUNIFY_USER_DB_FILE
    ? path.dirname(process.env.SUNIFY_USER_DB_FILE)
    : path.join(__dirname, '../data'),
  DISCORD_CLIENT_ID: '1570821512984793228',
};
