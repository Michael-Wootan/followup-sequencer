'use strict';
/**
 * config.js: env + config/*.json loader. Sender identity, follow-up copy and
 * the list of logs to work through all live outside the code.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), override: true, quiet: true });

const CONFIG_DIR = process.env.CONFIG_DIR || path.join(ROOT, 'config');
const STATE_DIR  = process.env.STATE_DIR  || path.join(ROOT, 'state');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

function loadConfig(name) {
  for (const file of [`${name}.json`, `${name}.example.json`]) {
    const p = path.join(CONFIG_DIR, file);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error(`Missing ${path.join(CONFIG_DIR, name + '.json')}`);
}

const company   = loadConfig('company');
const templates = loadConfig('templates');

// Comma-separated list of outreach logs. Relative paths resolve against STATE_DIR.
const LOG_FILES = (process.env.OUTREACH_LOG_FILES || 'outreach-log.json')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(p => (path.isAbsolute(p) ? p : path.join(STATE_DIR, p)));

module.exports = { ROOT, CONFIG_DIR, STATE_DIR, company, templates, LOG_FILES };
