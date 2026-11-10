#!/usr/bin/env node
/**
 * follow-up.js: follow-up cadence over one or more outreach logs
 *
 * Works on any log shaped { "<key>": { email, subject, lastSent, status } }.
 * List the logs in OUTREACH_LOG_FILES. A sender that runs its own follow-up
 * cycle must NOT be listed here: two engines on one log double-send.
 *
 * Sequence:
 *   Day 0   initial pitch (sent by the sender script)
 *   Day 4+  Follow-Up #1: short value-add bump with one concrete idea
 *   Day 10+ Follow-Up #2: polite breakup note (breakups get replies)
 *   Day 18+ mark cold. Any contact older than 18 days that never got a
 *           follow-up is marked cold WITHOUT emailing, which prevents zombie
 *           follow-ups to months-old contacts after downtime.
 *
 * Safety: validates addresses, honors the suppression list (bounced
 * addresses), detects replies by sender address OR "Re:" subject match,
 * caps sends per run, and staggers sends with human-like delays.
 *
 * Usage:
 *   node src/follow-up.js --dry-run   # preview follow-ups, don't send
 *   node src/follow-up.js             # send follow-ups
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const Imap = require('imap');
const { isValidEmailAddress, loadSuppression, isSuppressed } = require('./email-validation');
const { company, templates, LOG_FILES } = require('./config');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Config ──────────────────────────────────────────────────────────────────
const SMTP_HOST = process.env.OUTREACH_SMTP_HOST;
const SMTP_PORT = parseInt(process.env.OUTREACH_SMTP_PORT || '587');
const SMTP_USER = process.env.OUTREACH_SMTP_USER;
const SMTP_PASS = process.env.OUTREACH_SMTP_PASS;
const IMAP_HOST = process.env.OUTREACH_IMAP_HOST;
const FROM_EMAIL = process.env.OUTREACH_FROM_EMAIL || SMTP_USER;
const FROM_NAME = process.env.SENDER_NAME || company.senderName;

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const NOTIFY = process.env.EMAIL_NOTIFY || GMAIL_USER;

// Cadence: bump early while the original email is still findable in their
// inbox; break up before you become wallpaper.
const FOLLOWUP_1_DAYS = parseInt(process.env.FOLLOWUP_1_DAYS || '4', 10);
const FOLLOWUP_2_DAYS = parseInt(process.env.FOLLOWUP_2_DAYS || '10', 10);
const COLD_DAYS = parseInt(process.env.COLD_DAYS || '18', 10);

const MAX_SENDS_PER_RUN = parseInt(process.env.MAX_SENDS_PER_RUN || '10', 10);

function humanDelay() {
  const ms = (45 + Math.floor(Math.random() * 45)) * 1000;
  console.log(`   Waiting ${Math.round(ms / 1000)}s before next send...`);
  return new Promise(r => setTimeout(r, ms));
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function daysSince(dateStr) { return (Date.now() - new Date(dateStr).getTime()) / 86400000; }
function normalizeSubject(s) {
  return (s || '').replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ── Check the outreach inbox for replies (by address AND by subject) ────────
async function getReplySignals() {
  const signals = { emails: new Set(), subjects: new Set() };
  if (!SMTP_PASS || !IMAP_HOST) return signals;

  return new Promise((resolve) => {
    const imap = new Imap({
      user: SMTP_USER,
      password: SMTP_PASS,
      host: IMAP_HOST,
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 15000,
    });

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err || !box || box.messages.total === 0) {
          imap.end();
          return resolve(signals);
        }

        const since = new Date(Date.now() - 45 * 86400000);
        imap.search([['SINCE', since.toISOString().slice(0, 10)]], (err, results) => {
          if (err || !results || results.length === 0) {
            imap.end();
            return resolve(signals);
          }

          const fetch = imap.fetch(results, { bodies: 'HEADER.FIELDS (FROM SUBJECT)' });
          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              let data = '';
              stream.on('data', (chunk) => { data += chunk.toString('utf8'); });
              stream.on('end', () => {
                const from = data.match(/From:\s*.*?<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/i);
                if (from) signals.emails.add(from[1].toLowerCase());
                const subj = data.match(/Subject:\s*([^\r\n]+)/i);
                if (subj && /^\s*(re|aw)\s*:/i.test(subj[1])) {
                  signals.subjects.add(normalizeSubject(subj[1]));
                }
              });
            });
          });
          fetch.once('end', () => { imap.end(); resolve(signals); });
          fetch.once('error', () => { imap.end(); resolve(signals); });
        });
      });
    });

    imap.once('error', () => resolve(signals));
    imap.connect();
  });
}

// ── Follow-up templates (value-add bump, then breakup) ──────────────────────
function siteName(domain, entry) {
  return entry.name && entry.name !== domain ? entry.name : domain.replace(/\.(com|net|org|io|co)$/, '');
}

// Templates live in config/templates.json. Placeholders: {{site}}, {{signature}}
function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
}

function getFollowUp1(domain, entry) {
  return {
    subject: `Re: ${entry.subject}`,
    body: render(templates.followUp1, { site: siteName(domain, entry), signature: company.signature }),
  };
}

function getFollowUp2(domain, entry) {
  return {
    subject: `Re: ${entry.subject}`,
    body: render(templates.followUp2, { site: siteName(domain, entry), signature: company.signature }),
  };
}

// ── Send follow-up from the outreach mailbox ────────────────────────────────
async function sendFollowUp(toEmail, followUp) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to: toEmail,
    bcc: NOTIFY,
    replyTo: FROM_EMAIL,
    subject: followUp.subject,
    text: followUp.body,
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`🔄 Follow-Up Automation: ${new Date().toISOString().slice(0, 10)}`);
  console.log(`   Cadence: FU1 @ ${FOLLOWUP_1_DAYS}d, FU2 @ ${FOLLOWUP_2_DAYS}d, cold @ ${COLD_DAYS}d`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`${'═'.repeat(65)}`);

  if (!SMTP_PASS && !DRY_RUN) {
    console.error('❌ OUTREACH_SMTP_PASS not set: cannot send follow-ups.');
    process.exit(1);
  }

  console.log(`\n📥 Checking ${SMTP_USER || 'the outreach inbox'} for replies...`);
  const replies = await getReplySignals();
  console.log(`   ${replies.emails.size} unique senders / ${replies.subjects.size} reply-subjects (last 45 days)\n`);

  const suppression = loadSuppression();
  let sent1 = 0, sent2 = 0, replied = 0, cold = 0, waiting = 0, suppressed = 0;
  let totalSent = 0;

  for (const logFile of LOG_FILES) {
    const logName = path.basename(logFile);
    if (!fs.existsSync(logFile)) continue;
    const log = loadJson(logFile);
    if (!log || Object.keys(log).length === 0) continue;

    console.log(`📋 Processing ${logName}...`);
    let modified = false;

    for (const [domain, entry] of Object.entries(log)) {
      if (!entry || typeof entry !== 'object' || !entry.lastSent || !entry.email) continue;

      const days = daysSince(entry.lastSent);

      // Reply detected: by address or by "Re:" subject match
      const repliedByEmail = replies.emails.has(entry.email.toLowerCase());
      const repliedBySubject = entry.subject && replies.subjects.has(normalizeSubject(entry.subject));
      if (repliedByEmail || repliedBySubject) {
        if (entry.status !== 'replied') {
          console.log(`   ✅ ${domain}: REPLIED (${repliedByEmail ? 'address' : 'subject'} match)`);
          entry.status = 'replied';
          entry.repliedAt = new Date().toISOString();
          modified = true;
          replied++;
        }
        continue;
      }

      // Terminal states
      if (['replied', 'cold', 'follow2-sent', 'link-placed', 'suppressed', 'invalid-email'].includes(entry.status)) continue;

      // SAFEGUARD: contacts past the cold window get marked cold WITHOUT a
      // send: never "follow up" on something from months ago.
      if (days >= COLD_DAYS) {
        console.log(`   ❄️ ${domain}: too old (${Math.floor(days)}d), marked cold without emailing`);
        entry.status = 'cold';
        modified = true;
        cold++;
        continue;
      }

      // SAFEGUARD: bad or bounced addresses never get follow-ups
      if (!isValidEmailAddress(entry.email)) {
        entry.status = 'invalid-email';
        modified = true;
        suppressed++;
        continue;
      }
      if (isSuppressed(suppression, entry.email)) {
        entry.status = 'suppressed';
        modified = true;
        suppressed++;
        continue;
      }

      if (totalSent >= MAX_SENDS_PER_RUN) { waiting++; continue; }

      // Follow-Up #2 (day 10+, after FU1)
      if (days >= FOLLOWUP_2_DAYS && entry.status === 'follow1-sent') {
        const followUp = getFollowUp2(domain, entry);
        console.log(`   📤 ${domain}: Follow-Up #2 (${Math.floor(days)}d) → ${entry.email}`);
        if (!DRY_RUN) {
          try {
            await sendFollowUp(entry.email, followUp);
            entry.status = 'follow2-sent';
            entry.follow2At = new Date().toISOString();
            modified = true;
            totalSent++;
            if (totalSent < MAX_SENDS_PER_RUN) await humanDelay();
          } catch (e) { console.log(`      ❌ Failed: ${e.message}`); }
        }
        sent2++;
        continue;
      }

      // Follow-Up #1 (day 4+)
      if (days >= FOLLOWUP_1_DAYS && ['drafted', 'sent'].includes(entry.status)) {
        const followUp = getFollowUp1(domain, entry);
        console.log(`   📤 ${domain}: Follow-Up #1 (${Math.floor(days)}d) → ${entry.email}`);
        if (!DRY_RUN) {
          try {
            await sendFollowUp(entry.email, followUp);
            entry.status = 'follow1-sent';
            entry.follow1At = new Date().toISOString();
            modified = true;
            totalSent++;
            if (totalSent < MAX_SENDS_PER_RUN) await humanDelay();
          } catch (e) { console.log(`      ❌ Failed: ${e.message}`); }
        }
        sent1++;
        continue;
      }

      waiting++;
    }

    if (modified && !DRY_RUN) saveJson(logFile, log);
  }

  // ── Summary notification (only when something happened) ──
  if ((sent1 + sent2 + replied) > 0 && !DRY_RUN && GMAIL_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 587, secure: false,
        auth: { user: GMAIL_USER, pass: GMAIL_PASS },
      });
      await transporter.sendMail({
        from: `"${company.name} Outreach" <${GMAIL_USER}>`,
        to: NOTIFY,
        subject: `[${company.name} | Outreach] Follow-Up Report: ${new Date().toISOString().slice(0, 10)}`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:600px">
<h2 style="color:#2e7d32">🔄 Follow-Up Summary</h2>
<table style="border-collapse:collapse">
<tr><td style="padding:4px 16px 4px 0">Follow-Up #1 sent (day ${FOLLOWUP_1_DAYS}+)</td><td><strong>${sent1}</strong></td></tr>
<tr><td style="padding:4px 16px 4px 0">Follow-Up #2 sent (day ${FOLLOWUP_2_DAYS}+)</td><td><strong>${sent2}</strong></td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#2e7d32">Replies detected</td><td><strong style="color:#2e7d32">${replied}</strong></td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#888">Marked cold</td><td><strong>${cold}</strong></td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#888">Invalid/suppressed cleaned</td><td><strong>${suppressed}</strong></td></tr>
</table>
<p style="margin-top:16px;color:#888;font-size:12px">${waiting} contacts still in their wait window.</p>
</div>`,
      });
    } catch (e) { console.warn('   Notification failed:', e.message); }
  }

  console.log(`\n${'═'.repeat(65)}`);
  console.log(`✅ Done: FU1: ${sent1} | FU2: ${sent2} | replied: ${replied} | cold: ${cold} | cleaned: ${suppressed} | waiting: ${waiting}`);
  console.log(`${'═'.repeat(65)}\n`);
})();
