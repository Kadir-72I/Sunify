// src/config.js
const path = require('path');

module.exports = {
  PORT: process.env.PORT || 3001,
  API_BASE: 'http://localhost:3001/api',
  DEFAULT_THEME: 'sunify',
  APP_NAME: 'Sunify',
  VERSION: '1.0.0',
  DATA_DIR: path.join(__dirname, '../data'),
  DISCORD_CLIENT_ID: '1215372480352526366',
};
