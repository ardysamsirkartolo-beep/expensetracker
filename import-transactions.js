#!/usr/bin/env node
/**
 * import-transactions.js — One-time import from credit card CSVs to Drive.
 *
 * Reads:
 *   D:\Downloads\Ciitibank.csv         (Citi Cash Back+ — no header, 5-col)
 *   D:\Downloads\dbs altitude 1.csv    (DBS Altitude — header on row 7)
 *   D:\Downloads\dbs altitude 2.csv    (DBS Altitude — header on row 7)
 *
 * Writes to Drive (replaces existing):
 *   expenses.json     — all categorised one-off expenses
 *   recurring.json    — SP Group, Patreon, Rovo Premium, Claude AI
 *
 * Run:  node import-transactions.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ── Config ────────────────────────────────────────────────────────────────────
const SOURCES = {
  citi: 'D:\\Downloads\\Ciitibank.csv',
  dbs1: 'D:\\Downloads\\dbs altitude 1.csv',
  dbs2: 'D:\\Downloads\\dbs altitude 2.csv',
};
const FOLDER_NAME = process.env.DRIVE_FOLDER_NAME || 'ExpenseTracker';
const EXPENSES_FILE  = 'expenses.json';
const RECURRING_FILE = 'recurring.json';

// Local Drive sync folder — if set, write directly there (Drive syncs to cloud).
// Set DRIVE_LOCAL_PATH in .env, e.g. DRIVE_LOCAL_PATH=H:\\My Drive\\ExpenseTracker
const DRIVE_LOCAL_PATH = process.env.DRIVE_LOCAL_PATH || 'H:\\My Drive\\ExpenseTracker';

const CITI_CARD = 'citi-cashback-plus';
const DBS_CARD  = 'dbs-altitude';

// ── Categorisation rules — first match wins ──────────────────────────────────
// Each rule: [regex, category, subcategory]
const RULES = [
  // Specific overrides first (Others bucket)
  [/SUTDHMSCC/i,                                   'Others',        'Gym / Fitness'],
  [/EZYPAY.*KALLANG|KALLANG/i,                     'Others',        'Gym / Fitness'],
  [/PRISM TECH/i,                                  'Others',        'Home / Reno'],
  [/\bHDB\b/i,                                     'Others',        'Home / Reno'],

  // Subscriptions — streaming, SaaS, AI, in-app, etc.
  [/CLAUDE|ANTHROPIC/i,                            'Subscriptions', 'Claude / AI'],
  [/ROVO/i,                                        'Subscriptions', 'Rovo Premium'],
  [/PATREON/i,                                     'Subscriptions', 'Patreon'],
  [/NETFLIX/i,                                     'Subscriptions', 'Netflix'],
  [/SPOTIFY/i,                                     'Subscriptions', 'Spotify'],
  [/DISNEY/i,                                      'Subscriptions', 'Disney+'],
  [/GOOGLE APPLE TV|APPLE TV/i,                    'Subscriptions', 'Apple TV'],
  [/GOOGLE ONE\b/i,                                'Subscriptions', 'Google One'],
  [/GOOGLE TELEGRAM|\bTELEGRAM\b/i,                'Subscriptions', 'Telegram'],
  [/GOOGLE MEGA|\bMEGA\b/i,                        'Subscriptions', 'MEGA'],
  [/GOOGLE PIKPAK|PIKPAK/i,                        'Subscriptions', 'PikPak'],
  [/PURE ANONYMOUS/i,                              'Subscriptions', 'VPN'],
  [/MICROSOFT|XBOX|GAME PASS/i,                    'Subscriptions', 'Game Pass'],
  [/NBA LEAGUE PASS/i,                             'Subscriptions', 'NBA League Pass'],
  [/TELE 5\.0|TELE5/i,                             'Subscriptions', 'Other Sub'],
  [/CHATGPT|OPENAI/i,                              'Subscriptions', 'ChatGPT / AI'],

  // Utilities — actual bills only
  [/SP DIGITAL.*UTIL|SP GROUP/i,                   'Utilities',     'SP Group (Electric)'],
  [/SINGTEL/i,                                     'Utilities',     'Singtel'],
  [/STARHUB/i,                                     'Utilities',     'StarHub'],
  [/\bM1\b/i,                                      'Utilities',     'M1'],
  [/VIEWQWEST/i,                                   'Utilities',     'Viewqwest'],

  // Online Shopping (specific stores before catch-all "ATOME")
  [/GOOGLE TIKTOK\b|\bTIKTOK\b(?!.*SHOP)/i,        'Online Shopping', 'In-App Purchase'],
  [/GOOGLE INSTAGRAM|\bINSTAGRAM\b/i,              'Online Shopping', 'In-App Purchase'],
  [/TIKTOK SHOP/i,                                 'Online Shopping', 'TikTok Shop'],
  [/MUSINSA/i,                                     'Online Shopping', 'MUSINSA'],
  [/SHOPEEPAY|SPAYLATER|SHOPEE/i,                  'Online Shopping', 'Shopee'],
  [/LAZADA/i,                                      'Online Shopping', 'Lazada'],
  [/AMAZON\.CO\.JP|AMAZON\.JP/i,                   'Online Shopping', 'Amazon JP'],
  [/AMAZON|AMZN/i,                                 'Online Shopping', 'Amazon'],
  [/ALIEXPRESS/i,                                  'Online Shopping', 'AliExpress'],
  [/IHERB/i,                                       'Online Shopping', 'iHerb'],
  [/CAROUSELL/i,                                   'Online Shopping', 'Carousell'],
  [/UNIQLO/i,                                      'Online Shopping', 'Uniqlo'],
  [/BEAMS/i,                                       'Online Shopping', 'Beams'],
  [/NOVELSHIP/i,                                   'Online Shopping', 'Novelship'],
  [/DAISO/i,                                       'Online Shopping', 'Daiso'],
  [/MUJI/i,                                        'Online Shopping', 'Muji'],
  [/WATSONS|GUARDIAN/i,                            'Online Shopping', 'Watsons / Guardian'],
  [/WOOTING|EPOMAKER|MEROSS|UNIKEYS|W8TECH|KTECHS|GAMEFOUND|GD GROUP/i,
                                                   'Online Shopping', 'Electronics'],
  [/ESCENTIALS|SEPHORA/i,                          'Online Shopping', 'Beauty'],
  [/RAP\*SINGAPORE POST/i,                         'Online Shopping', 'Post / Delivery'],
  [/ATOME/i,                                       'Online Shopping', 'Atome'],

  // Transport
  [/GRAB\*|GRAB SG|\bGRAB\b/i,                     'Transport',   'Grab / Gojek'],
  [/GOJEK/i,                                       'Transport',   'Grab / Gojek'],
  [/TADA/i,                                        'Transport',   'Tada'],
  [/BUS\/MRT/i,                                    'Transport',   'MRT / Bus'],
  [/ANYWHEEL/i,                                    'Transport',   'BlueSG / EV'],
  [/COMFORT/i,                                     'Transport',   'Taxi'],

  // Dining — venues
  [/CHAGEE|LIHO TEA|LUCKIN|COTTI|TEA EXPLORER|CHICHA SAN CHEN/i, 'Dining', 'Bubble Tea'],
  [/OLD CHANG KEE/i,                               'Dining',      'Bakery'],
  [/STARBUCKS|HOMEGROUND|NYLON COFFEE|ZEROCOFFEE|LATTICE COFFEE|TOSS N TURN/i,
                                                   'Dining',      'Cafe'],
  [/MCDONALD/i,                                    'Dining',      'Fast Food'],
  [/FP\*FOOD PANDA|FOODPANDA/i,                    'Dining',      'Foodpanda'],
  [/DELIVEROO/i,                                   'Dining',      'Deliveroo'],
  [/SUKIYA|DAPUR PENYET|ANTHDL|NOMVNOM|LIVE IT UP|PROPER CATERING/i,
                                                   'Dining',      'Restaurant'],
  [/FISH MART SAKURAYA|WING JOO LOONG/i,           'Dining',      'Restaurant'],
  [/SOFTPAY.*JINGXI|JINGXI/i,                      'Dining',      'Hawker / Food Court'],

  // Groceries
  [/NTUC FP|NTUC|FAIRPRICE/i,                      'Groceries',   'NTUC FairPrice'],
  [/COLD STORAGE/i,                                'Groceries',   'Cold Storage'],
  [/SHENG SIONG/i,                                 'Groceries',   'Sheng Siong'],
  [/\bGIANT\b/i,                                   'Groceries',   'Giant'],
  [/PRIME SUPERMARKET/i,                           'Groceries',   'Prime'],
  [/DON DON DONKI/i,                               'Groceries',   'Don Don Donki'],
  [/7-ELEVEN/i,                                    'Groceries',   '7-Eleven'],
  [/SCARLETT/i,                                    'Groceries',   'Wet Market'],
];

// ── Cards config (matches defaultCards() in index.html) ──────────────────────
const CARDS_SEED = [
  {
    id: 'dbs-altitude',
    name: 'DBS Altitude',
    color: '#1f4e79',
    benefits: [
      { category: 'Travel',          rate: 2.2, rateType: 'miles', cap: null, minSpend: 0,
        note: 'Best for offline FCY abroad. 3.25% FX fee → buying miles at ~1.47¢ each.' },
      { category: 'Dining',          rate: 1.3, rateType: 'miles', cap: null, minSpend: 0 },
      { category: 'Groceries',       rate: 1.3, rateType: 'miles', cap: null, minSpend: 0 },
      { category: 'Online Shopping', rate: 1.3, rateType: 'miles', cap: null, minSpend: 0 },
      { category: 'Transport',       rate: 1.3, rateType: 'miles', cap: null, minSpend: 0 },
      { category: 'Utilities',       rate: 1.3, rateType: 'miles', cap: null, minSpend: 0 },
      { category: 'Subscriptions',   rate: 1.3, rateType: 'miles', cap: null, minSpend: 0 },
      { category: 'Others',          rate: 1.3, rateType: 'miles', cap: null, minSpend: 0,
        note: 'Uncapped. DBS Points never expire on this card. Avoid sub-$5 buys (S$5 block rule).' }
    ],
    monthlyThresholds: []
  },
  {
    id: 'citi-cashback-plus',
    name: 'Citi Cash Back+',
    color: '#1abc9c',
    benefits: [
      { category: 'Dining',          rate: 1.6, rateType: 'cashback', cap: null, minSpend: 0 },
      { category: 'Groceries',       rate: 1.6, rateType: 'cashback', cap: null, minSpend: 0 },
      { category: 'Online Shopping', rate: 1.6, rateType: 'cashback', cap: null, minSpend: 0 },
      { category: 'Transport',       rate: 1.6, rateType: 'cashback', cap: null, minSpend: 0 },
      { category: 'Utilities',       rate: 1.6, rateType: 'cashback', cap: null, minSpend: 0 },
      { category: 'Subscriptions',   rate: 1.6, rateType: 'cashback', cap: null, minSpend: 0 },
      { category: 'Others',          rate: 1.6, rateType: 'cashback', cap: null, minSpend: 0,
        note: 'Uncapped catch-all. Best for big-ticket (renovations, dental, electronics) + sub-$5 spends.' }
    ],
    monthlyThresholds: []
  },
  {
    id: 'dbs-wwmc',
    name: "DBS Woman's World",
    color: '#c2185b',
    benefits: [
      { category: 'Online Shopping', rate: 4, rateType: 'miles', cap: null, minSpend: 0,
        note: 'Online only. $1000/mo TOTAL cap across all online categories on this card.' },
      { category: 'Transport',       rate: 4, rateType: 'miles', cap: null, minSpend: 0,
        note: 'Online ride-hailing only (Grab, Gojek). Offline drops to 0.4 mpd.' },
      { category: 'Travel',          rate: 4, rateType: 'miles', cap: null, minSpend: 0,
        note: 'Online flight/hotel bookings (airline direct, Agoda, Booking.com).' },
      { category: 'Dining',          rate: 4, rateType: 'miles', cap: null, minSpend: 0,
        note: 'Foodpanda/Deliveroo OR Kris+ at physical merchants.' },
      { category: 'Utilities',       rate: 4, rateType: 'miles', cap: null, minSpend: 0,
        note: 'Online recurring bills (telco portals).' },
      { category: 'Subscriptions',   rate: 4, rateType: 'miles', cap: null, minSpend: 0,
        note: 'Online streaming/SaaS subs (Netflix, Spotify, Claude, etc.).' }
    ],
    monthlyThresholds: [
      { spend: 1000, benefit: '$1000 online cap reached — switch to Altitude or Cash Back+ (drops to 0.4 mpd).' }
    ]
  }
];

// ── Recurring items to seed ──────────────────────────────────────────────────
const RECURRING_SEED = [
  // ── Variable bills (user enters amount each month via reminder) ────────────
  {
    id: 'rec-sp-group', type: 'recurring', name: 'SP Group',
    amount: 166.72, category: 'Utilities', card: CITI_CARD, note: '',
    variable: true, billDay: 12, reminderDay: 13, chargeDay: 26,
  },
  {
    id: 'rec-spaylater', type: 'recurring', name: 'Shopee PayLater',
    amount: 256.24, category: 'Online Shopping', card: CITI_CARD,
    note: 'Consolidated Shopee bill (BNPL + installments)',
    variable: true, billDay: 1, reminderDay: 2, chargeDay: 10,
  },
  {
    id: 'rec-pure-vpn', type: 'recurring', name: 'PURE VPN',
    amount: 15.99, category: 'Subscriptions', card: CITI_CARD, note: '',
    variable: true, billDay: 13, reminderDay: 14, chargeDay: 14,
  },

  // ── Fixed monthly subscriptions — DBS Altitude ────────────────────────────
  { id: 'rec-netflix',   type: 'recurring', name: 'Netflix',           amount: 29.98, category: 'Subscriptions', card: DBS_CARD, note: '' },
  { id: 'rec-nba-pass',  type: 'recurring', name: 'NBA League Pass',   amount: 27.26, category: 'Subscriptions', card: DBS_CARD, note: '' },
  { id: 'rec-game-pass', type: 'recurring', name: 'MS Game Pass',      amount: 16.49, category: 'Subscriptions', card: DBS_CARD, note: '' },
  { id: 'rec-patreon',   type: 'recurring', name: 'Patreon',           amount: 12,    category: 'Subscriptions', card: DBS_CARD, note: '' },
  { id: 'rec-rovo',      type: 'recurring', name: 'Rovo Premium',      amount: 5,     category: 'Subscriptions', card: DBS_CARD, note: '' },
  { id: 'rec-claude',    type: 'recurring', name: 'Claude AI',         amount: 30.30, category: 'Subscriptions', card: DBS_CARD, note: '' },
  { id: 'rec-amzn-prime',type: 'recurring', name: 'Amazon Prime',      amount: 49.90, category: 'Subscriptions', card: CITI_CARD, note: '', frequency: 'annual', renewalDate: '2026-12-19' },
  { id: 'rec-viewqwest', type: 'recurring', name: 'Viewqwest Internet',amount: 23.24, category: 'Utilities',     card: DBS_CARD, note: '' },

  // ── Fixed monthly subscriptions — Citi Cash Back+ ─────────────────────────
  { id: 'rec-spotify',    type: 'recurring', name: 'Spotify',    amount: 11.98, category: 'Subscriptions', card: CITI_CARD, note: '' },
  { id: 'rec-google-one', type: 'recurring', name: 'Google One', amount: 28.99, category: 'Subscriptions', card: CITI_CARD, note: '' },
  { id: 'rec-apple-tv',   type: 'recurring', name: 'Apple TV',   amount: 13.98, category: 'Subscriptions', card: CITI_CARD, note: '' },
  { id: 'rec-tele5',      type: 'recurring', name: 'Tele 5',     amount: 13.16, category: 'Subscriptions', card: CITI_CARD, note: '' },
  { id: 'rec-pikpak',     type: 'recurring', name: 'PikPak',     amount: 6.99,  category: 'Subscriptions', card: CITI_CARD, note: '' },
  { id: 'rec-mega',       type: 'recurring', name: 'MEGA',       amount: 7.49,  category: 'Subscriptions', card: CITI_CARD, note: '' },

  // ── Active installments ───────────────────────────────────────────────────
  {
    id: 'inst-creative-katana', type: 'installment',
    name: 'Creative Katana SE',
    amount: 230.04, monthsLeft: 2,
    category: 'Online Shopping', card: DBS_CARD,
    note: 'ShopeePay IPP — 3-month plan, 2 payments remaining',
  },
  {
    id: 'inst-atome-final', type: 'installment',
    name: 'Atome (final payment)',
    amount: 17.18, monthsLeft: 1,
    category: 'Online Shopping', card: DBS_CARD,
    note: 'Last Atome installment',
  },
];

// ── Skip rules — these are NOT expenses ──────────────────────────────────────
function shouldSkip(desc, type, signedAmount) {
  if (signedAmount > 0) return true;                          // credits/refunds/transfers
  if (type === 'REFUND & CREDITS') return true;
  if (type === 'PAYMENT') return true;
  if (/MONEYSEND/i.test(desc)) return true;
  if (/CASH REBATE/i.test(desc)) return true;
  if (/CCY CONVERSION FEE/i.test(desc)) return true;
  if (/PAYMENT VIA UOB/i.test(desc)) return true;
  return false;
}

// ── CSV parsing ──────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseDateDMY(s) {
  // "10/05/2026" → "2026-05-10"
  const [d, m, y] = s.replace(/[^\d/]/g, '').split('/');
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
function parseDateDBS(s) {
  // "11 May 2026" → "2026-05-11"
  const [d, m, y] = s.trim().split(/\s+/);
  return `${y}-${MONTHS[m]}-${d.padStart(2,'0')}`;
}

function categorise(desc) {
  for (const [re, cat, sub] of RULES) {
    if (re.test(desc)) return { category: cat, subcategory: sub || '' };
  }
  return { category: 'Others', subcategory: '' };
}

function cleanDesc(desc) {
  return desc.replace(/\s+/g, ' ').replace(/\s+(SINGAPORE|SGP|SG)$/i, '').trim();
}

// ── Source parsers ───────────────────────────────────────────────────────────
function parseCiti(filepath) {
  const lines = fs.readFileSync(filepath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const cols = parseCsvLine(line);
    if (cols.length < 3) continue;
    const dateStr = cols[0];
    const desc    = cols[1];
    const amount  = parseFloat(cols[2]);
    if (!dateStr || !desc || isNaN(amount)) continue;
    if (shouldSkip(desc, '', amount)) continue;
    out.push({
      date: parseDateDMY(dateStr),
      amount: Math.abs(amount),
      card: CITI_CARD,
      rawDesc: desc,
    });
  }
  return out;
}

function parseDBS(filepath) {
  const lines = fs.readFileSync(filepath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (!/^"\d{2}\s\w{3}\s\d{4}"/.test(line)) continue; // only transaction rows
    const cols = parseCsvLine(line);
    const dateStr = cols[0];
    const desc    = cols[2];
    const type    = cols[3] || '';
    const debit   = parseFloat(cols[6]);
    const credit  = parseFloat(cols[7]);
    if (!isNaN(credit) && credit > 0) continue;        // skip credit-side
    if (isNaN(debit) || debit <= 0) continue;
    if (shouldSkip(desc, type, -debit)) continue;
    out.push({
      date: parseDateDBS(dateStr),
      amount: debit,
      card: DBS_CARD,
      rawDesc: desc,
    });
  }
  return out;
}

// ── Build final expense rows ─────────────────────────────────────────────────
function buildExpenses() {
  const all = [
    ...parseCiti(SOURCES.citi),
    ...parseDBS(SOURCES.dbs1),
    ...parseDBS(SOURCES.dbs2),
  ];
  return all.map((row, i) => {
    const { category, subcategory } = categorise(row.rawDesc);
    return {
      id: `imp-${Date.now()}-${i}`,
      date: row.date,
      amount: Math.round(row.amount * 100) / 100,
      category,
      subcategory,
      card: row.card,
      note: cleanDesc(row.rawDesc),
      ts: new Date(row.date).getTime() + i, // chronological-ish
    };
  });
}

// ── Drive helpers ────────────────────────────────────────────────────────────
function makeAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

async function findFile(drive, name, folderId) {
  const q = `name='${name}' and '${folderId}' in parents and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive', pageSize: 5 });
  return res.data.files?.[0] || null;
}

async function findFolder(drive, name) {
  const res = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)', spaces: 'drive', pageSize: 5
  });
  return res.data.files?.[0] || null;
}

async function uploadJson(drive, fileId, data) {
  return drive.files.update({
    fileId,
    media: { mimeType: 'application/json', body: JSON.stringify(data, null, 2) },
  });
}

async function readJson(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'json' });
  return res.data;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[import] Parsing CSVs…');
  const expenses = buildExpenses();
  console.log(`[import] Built ${expenses.length} expenses`);

  // Category summary
  const byCat = expenses.reduce((m, e) => { m[e.category] = (m[e.category]||0) + e.amount; return m; }, {});
  console.log('\n[import] Category totals:');
  for (const [c, v] of Object.entries(byCat).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(18)} $${v.toFixed(2)}`);
  }
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  console.log(`  ${'TOTAL'.padEnd(18)} $${total.toFixed(2)}\n`);

  // Always save local backups first (so we never lose work to an expired token)
  const outDir = path.join(__dirname, 'import-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const expJson  = JSON.stringify(expenses,       null, 2);
  const recJson  = JSON.stringify(RECURRING_SEED, null, 2);
  const cardJson = JSON.stringify(CARDS_SEED,     null, 2);
  fs.writeFileSync(path.join(outDir, 'expenses.json'),     expJson);
  fs.writeFileSync(path.join(outDir, 'recurring.json'),    recJson);
  fs.writeFileSync(path.join(outDir, 'cards-config.json'), cardJson);
  console.log(`[import] Saved local backups in ./import-output/`);

  // Write directly to local Drive sync folder if present — Drive auto-syncs to cloud
  if (DRIVE_LOCAL_PATH && fs.existsSync(DRIVE_LOCAL_PATH)) {
    fs.writeFileSync(path.join(DRIVE_LOCAL_PATH, 'expenses.json'),     expJson);
    fs.writeFileSync(path.join(DRIVE_LOCAL_PATH, 'recurring.json'),    recJson);
    fs.writeFileSync(path.join(DRIVE_LOCAL_PATH, 'cards-config.json'), cardJson);
    console.log(`[import] Wrote to Drive sync folder: ${DRIVE_LOCAL_PATH}`);
    console.log(`[import] Done — Drive will auto-sync to cloud. Refresh the app.`);
    return;
  }
  console.log(`[import] DRIVE_LOCAL_PATH not found — falling back to OAuth upload…`);

  // Connect Drive
  console.log('[import] Connecting to Drive…');
  const auth  = makeAuth();
  const drive = google.drive({ version: 'v3', auth });

  let folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    const folder = await findFolder(drive, FOLDER_NAME);
    if (!folder) throw new Error('Drive folder not found: ' + FOLDER_NAME);
    folderId = folder.id;
  }
  console.log('[import] Folder id:', folderId);

  const expFile = await findFile(drive, EXPENSES_FILE, folderId);
  const recFile = await findFile(drive, RECURRING_FILE, folderId);
  if (!expFile) throw new Error('expenses.json not found in folder');
  if (!recFile) throw new Error('recurring.json not found in folder');

  // Merge recurring: keep existing items not in seed (by id), add seed
  console.log('[import] Reading existing recurring.json…');
  const existingRec = await readJson(drive, recFile.id);
  const seedIds = new Set(RECURRING_SEED.map(r => r.id));
  const preserved = (Array.isArray(existingRec) ? existingRec : []).filter(r => !seedIds.has(r.id));
  const newRec = [...preserved, ...RECURRING_SEED];

  console.log(`[import] Uploading ${expenses.length} expenses (replacing existing)…`);
  await uploadJson(drive, expFile.id, expenses);
  console.log(`[import] Uploading ${newRec.length} recurring items…`);
  await uploadJson(drive, recFile.id, newRec);

  console.log('\n[import] Done. Refresh the app to see imported data.');
}

main().catch(e => { console.error('[import] Fatal:', e.message); process.exit(1); });
