// src/utils/logger.js
const fs = require('fs');
const os = require('os');
const path = require('path');

class Logger {
  constructor() {
    const baseDataDir = process.env.SUNIFY_USER_DB_FILE
      ? path.dirname(process.env.SUNIFY_USER_DB_FILE)
      : __dirname.includes('app.asar')
        ? path.join(os.tmpdir(), 'SunifyPlayerData')
        : path.join(__dirname, '../../data');
    this.logDir = path.join(baseDataDir, 'logs');
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (e) {
      // Fallback
    }
    this.logFile = path.join(this.logDir, 'sunify.log');
  }

  _format(level, msg, meta) {
    const ts = new Date().toISOString();
    const metaStr = meta ? ` ${typeof meta === 'object' ? JSON.stringify(meta) : meta}` : '';
    return `[${ts}] [${level.toUpperCase()}] ${msg}${metaStr}\n`;
  }

  _write(level, msg, meta) {
    const formatted = this._format(level, msg, meta);
    try {
      fs.appendFileSync(this.logFile, formatted, 'utf8');
    } catch (e) {
      // Silently ignore log write errors
    }
    if (process.env.NODE_ENV !== 'production') {
      const consoleMsg = `[Sunify ${level.toUpperCase()}] ${msg}`;
      if (level === 'error') console.error(consoleMsg, meta || '');
      else if (level === 'warn') console.warn(consoleMsg, meta || '');
      else console.log(consoleMsg, meta || '');
    }
  }

  info(msg, meta) {
    this._write('info', msg, meta);
  }
  warn(msg, meta) {
    this._write('warn', msg, meta);
  }
  error(msg, meta) {
    this._write('error', msg, meta);
  }
}

module.exports = new Logger();
