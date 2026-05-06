#!/usr/bin/env node
/**
 * notify.js — Daily Telegram expense summary
 * Reads expenses.json from Google Drive, sends 8am SGT digest.
 *
 * Setup:
 *   npm install googleapis node-fetch dotenv
 *   node setup-auth.js          ← run once to get refresh token
 *   node notify.js              ← test manually
 *
 * Cron (laptop, 8am SGT = 0am UTC):
 *   0 0 * * * cd /path/to/project && node notify.js >> notify.log 2>&1
 *
 * GitHub Actions: see .github/workflows/daily-notify.yml
 */

require('dotenv').config();
const { google } = require('googleapis');

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_API  = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const CHAT_ID       = process.env.TELEGRAM_CHAT_ID;
const FOLDER_NAME   = process.env.DRIVE_FOLDER_NAME || 'ExpenseTracker';
const EXPENSES_FILE = 'expenses.json';
const CARDS_FILE    = 'cards-config.json';
const CURRENCY      = process.env.CURRENCY || 'SGD';

const CATEGORIES = ['Dining','Groceries','Online Shopping','Transport','Travel','Utilities','Others'];
const CAT_ICON   = { Dining:'🍜', Groceries:'🛒', 'Online Shopping':'🛍️', Transport:'🚇', Travel:'✈️', Utilities:'💡', Others:'📦' };

// ── Auth ──────────────────────────────────────────────────────────────────────
function makeAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

// ── Drive helpers ─────────────────────────────────────────────────────────────
async function findFile(drive, name, folderId) {
  const q = folderId
    ? `name='${name}' and '${folderId}' in parents and trashed=false`
    : `name='${name}' and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive', pageSize: 5 });
  return res.data.files?.[0] || null;
}

async function readJson(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'json' });
  return res.data;
}

async function findFolder(drive, name) {
  const res = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)', spaces: 'drive', pageSize: 5
  });
  return res.data.files?.[0] || null;
}

// ── Business logic ────────────────────────────────────────────────────────────
function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function fmt(n) {
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function monthExpenses(expenses, month) {
  return expenses.filter(e => e.date.startsWith(month));
}

function spendByCategory(list) {
  return list.reduce((m, e) => { m[e.category] = (m[e.category]||0) + e.amount; return m; }, {});
}

function spendByCard(list, cards) {
  const res = {};
  for (const c of cards) res[c.id] = 0;
  for (const e of list) if (res[e.card] !== undefined) res[e.card] += e.amount;
  return res;
}

function bestCard(category, cards) {
  let best = null, top = -1;
  for (const c of cards) {
    const b = (c.benefits||[]).find(x => x.category === category);
    if (b && b.rate > top) { top = b.rate; best = { card: c, benefit: b }; }
  }
  return best;
}

function rateLabel(b) {
  return b.rateType === 'cashback' ? `${b.rate}%` : `${b.rate} ${b.rateType}/dollar`;
}

function thresholdAlerts(cards, expenses, month) {
  const list = monthExpenses(expenses, month);
  const alerts = [];
  for (const card of cards) {
    const spent = list.filter(e => e.card === card.id).reduce((s,e) => s+e.amount, 0);
    for (const t of (card.monthlyThresholds||[])) {
      const rem = t.spend - spent;
      if (rem > 0) {
        alerts.push({ card, spent, remaining: rem, threshold: t });
      }
    }
  }
  return alerts;
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const https = require('https');
  const body  = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${TELEGRAM_API}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d=''; res.on('data', c => d+=c); res.on('end', () => resolve(JSON.parse(d))); }
    );
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Build message (HTML parse mode) ──────────────────────────────────────────
function cardDisplayName(cards, cardId) {
  return cards.find(c => c.id === cardId)?.name || `Unknown (${cardId})`;
}

function buildMessage(expenses, cards) {
  const month    = currentMonth();
  const todayStr = today();
  const moList   = monthExpenses(expenses, month);
  const todayList= expenses.filter(e => e.date === todayStr);
  const tot      = moList.reduce((s,e) => s+e.amount, 0);
  const dayOfMo  = new Date().getDate();
  const byCard   = spendByCard(moList, cards);
  const byCat    = spendByCategory(moList);
  const d        = new Date();
  const dateStr  = d.toLocaleDateString('en-SG', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const monStr   = d.toLocaleDateString('en-SG', { month:'long', year:'numeric' });

  const lines = [];

  lines.push(`💳 <b>Daily Expense Summary</b>`);
  lines.push(`<i>${dateStr}</i>`);
  lines.push('');

  lines.push(`📅 <b>${monStr}</b> — <code>$${fmt(tot)} ${CURRENCY}</code>`);
  lines.push(`Day ${dayOfMo} · Daily avg: <code>$${fmt(dayOfMo > 0 ? tot / dayOfMo : 0)}</code>`);
  lines.push('');

  // Best card per category
  lines.push(`💡 <b>Best Card by Category</b>`);
  for (const cat of CATEGORIES) {
    const b = bestCard(cat, cards);
    if (!b) continue;
    lines.push(`${CAT_ICON[cat]} ${cat} → <b>${b.card.name}</b> (${rateLabel(b.benefit)})`);
  }
  lines.push('');

  // Spending by category
  const catKeys = CATEGORIES.filter(c => byCat[c]);
  if (catKeys.length) {
    lines.push(`📊 <b>Spending This Month</b>`);
    for (const cat of catKeys) {
      lines.push(`${CAT_ICON[cat]} ${cat}: <code>$${fmt(byCat[cat])}</code>`);
    }
    lines.push('');
  }

  // Card balances (calendar month — billing cycle days stored in app only)
  lines.push(`💳 <b>Card Spend (calendar month)</b>`);
  for (const card of cards) {
    const spent = byCard[card.id] || 0;
    lines.push(`• <b>${card.name}</b>: <code>$${fmt(spent)}</code>`);
  }
  lines.push('');

  // Threshold alerts
  const alerts = thresholdAlerts(cards, expenses, month);
  if (alerts.length) {
    lines.push(`⚡ <b>Threshold Alerts</b>`);
    for (const a of alerts) {
      lines.push(`• <b>${a.card.name}</b>: <code>$${fmt(a.remaining)}</code> more → ${a.threshold.benefit}`);
    }
    lines.push('');
  }

  // Today's expenses
  if (todayList.length) {
    lines.push(`🧾 <b>Today's Expenses</b>`);
    for (const e of todayList) {
      const notePart = e.note ? ` <i>${e.note}</i>` : '';
      const cardN    = cardDisplayName(cards, e.card);
      lines.push(`• <code>$${fmt(e.amount)}</code> ${CAT_ICON[e.category]||''}${e.category}${notePart} [${cardN}]`);
    }
  } else {
    lines.push(`<i>No expenses logged today.</i>`);
  }

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Validate env
  const required = ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('Missing env vars:', missing.join(', '));
    console.error('Run: node setup-auth.js');
    process.exit(1);
  }

  console.log('[notify] Starting at', new Date().toISOString());

  const auth  = makeAuth();
  const drive = google.drive({ version: 'v3', auth });

  // Find folder
  let folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    const folder = await findFolder(drive, FOLDER_NAME);
    if (!folder) { console.error('[notify] Drive folder not found:', FOLDER_NAME); process.exit(1); }
    folderId = folder.id;
    console.log('[notify] Found folder:', folderId);
  }

  // Read files
  const [expFile, cardFile] = await Promise.all([
    findFile(drive, EXPENSES_FILE, folderId),
    findFile(drive, CARDS_FILE, folderId),
  ]);

  if (!expFile)  { console.error('[notify] expenses.json not found'); process.exit(1); }
  if (!cardFile) { console.error('[notify] cards-config.json not found'); process.exit(1); }

  const [expenses, cards] = await Promise.all([
    readJson(drive, expFile.id),
    readJson(drive, cardFile.id),
  ]);

  console.log(`[notify] Loaded ${expenses.length} expenses, ${cards.length} cards`);

  const message = buildMessage(expenses, cards);
  console.log('[notify] Message:\n' + message);

  const result = await sendTelegram(message);
  if (result.ok) {
    console.log('[notify] Sent successfully, message_id:', result.result.message_id);
  } else {
    console.error('[notify] Telegram error:', result);
    process.exit(1);
  }
}

main().catch(e => { console.error('[notify] Fatal:', e); process.exit(1); });
