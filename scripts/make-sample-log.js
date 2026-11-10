#!/usr/bin/env node
'use strict';
/**
 * Writes a small sample outreach log with dates relative to today, so
 * `npm run sample` shows every branch of the cadence in a dry run:
 * too early, follow-up 1 due, follow-up 2 due, cold without a send,
 * malformed address, and already replied.
 */
const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('../src/config');

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
const log = {
  'too-early.example':  { name: 'Too Early Blog',  email: 'editor@too-early.example',  subject: 'Guest article idea', lastSent: daysAgo(2),  status: 'sent' },
  'bump-due.example':   { name: 'Bump Due Weekly', email: 'hello@bump-due.example',    subject: 'Guest article idea', lastSent: daysAgo(5),  status: 'sent' },
  'breakup-due.example':{ name: 'Breakup Due',     email: 'team@breakup-due.example',  subject: 'Guest article idea', lastSent: daysAgo(11), status: 'follow1-sent' },
  'gone-cold.example':  { name: 'Gone Cold',       email: 'info@gone-cold.example',    subject: 'Guest article idea', lastSent: daysAgo(40), status: 'sent' },
  'bad-address.example':{ name: 'Bad Address',     email: 'logo@2x.png',               subject: 'Guest article idea', lastSent: daysAgo(6),  status: 'sent' },
  'answered.example':   { name: 'Answered',        email: 'sam@answered.example',      subject: 'Guest article idea', lastSent: daysAgo(7),  status: 'replied' },
};
const out = path.join(STATE_DIR, 'outreach-log.json');
if (fs.existsSync(out) && !process.argv.includes('--force')) {
  console.error(`${out} already exists. Re-run with --force to overwrite it.`);
  process.exit(1);
}
fs.writeFileSync(out, JSON.stringify(log, null, 2));
console.log(`Sample log written to ${out}`);
