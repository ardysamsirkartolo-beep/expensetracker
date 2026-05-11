#!/usr/bin/env node
/**
 * setup-auth.js — One-time OAuth setup for notify.js
 *
 * Run:  node setup-auth.js
 *
 * It will open a browser URL. Paste the code it gives you back here.
 * Your .env will be updated with GOOGLE_REFRESH_TOKEN and DRIVE_FOLDER_ID.
 */

require('dotenv').config();
const { google } = require('googleapis');
const readline   = require('readline');
const fs         = require('fs');
const path       = require('path');

const ENV_FILE = path.join(__dirname, '.env');

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function upsertEnv(key, value) {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const regex = new RegExp(`^${key}=.*`, 'm');
  const line  = `${key}=${value}`;
  if (regex.test(content)) content = content.replace(regex, line);
  else content += (content.endsWith('\n') || !content ? '' : '\n') + line + '\n';
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

async function main() {
  console.log('\n=== Expense Tracker — One-time Auth Setup ===\n');

  let clientId     = process.env.GOOGLE_CLIENT_ID;
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId)     clientId     = await prompt('Google OAuth Client ID:     ');
  if (!clientSecret) clientSecret = await prompt('Google OAuth Client Secret: ');

  upsertEnv('GOOGLE_CLIENT_ID',     clientId);
  upsertEnv('GOOGLE_CLIENT_SECRET', clientSecret);

  const auth = new google.auth.OAuth2(clientId, clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
  const url  = auth.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    prompt: 'consent',
  });

  console.log('\n1. Open this URL in your browser:\n');
  console.log(url);
  console.log('\n2. Sign in, grant access, and copy the code shown.\n');

  const code = await prompt('Paste the code here: ');
  const { tokens } = await auth.getToken(code);
  console.log('\nGot tokens:', Object.keys(tokens).join(', '));

  if (!tokens.refresh_token) {
    console.error('\n⚠️  No refresh_token returned. This can happen if you already granted access.');
    console.error('Go to https://myaccount.google.com/permissions, revoke access for your OAuth app, then re-run.\n');
    process.exit(1);
  }

  upsertEnv('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
  console.log('✅ GOOGLE_REFRESH_TOKEN saved to .env');

  // Find DRIVE_FOLDER_ID
  auth.setCredentials(tokens);
  const drive = google.drive({ version: 'v3', auth });
  const folderName = process.env.DRIVE_FOLDER_NAME || 'ExpenseTracker';

  console.log(`\nLooking for "${folderName}" folder on Drive…`);
  const res = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)', spaces: 'drive', pageSize: 5
  });

  let folderId;
  if (res.data.files?.length) {
    folderId = res.data.files[0].id;
    console.log(`✅ Found folder: ${folderId}`);
  } else {
    console.log(`Folder not found. Creating "${folderName}"…`);
    const f = await drive.files.create({
      requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id,name'
    });
    folderId = f.data.id;
    console.log(`✅ Created folder: ${folderId}`);
  }

  upsertEnv('DRIVE_FOLDER_ID', folderId);

  // Telegram setup
  console.log('\n=== Telegram Setup ===');
  let botToken = process.env.TELEGRAM_BOT_TOKEN;
  let chatId   = process.env.TELEGRAM_CHAT_ID;

  if (!botToken) {
    console.log('Create a bot via @BotFather on Telegram and get your token.');
    botToken = await prompt('Telegram Bot Token: ');
    upsertEnv('TELEGRAM_BOT_TOKEN', botToken);
  }

  if (!chatId) {
    console.log('To get your Chat ID:');
    console.log('  1. Send any message to your bot');
    console.log(`  2. Open: https://api.telegram.org/bot${botToken}/getUpdates`);
    console.log('  3. Find "chat":{"id": NNNNNN} in the response');
    chatId = await prompt('Telegram Chat ID: ');
    upsertEnv('TELEGRAM_CHAT_ID', chatId);
  }

  console.log('\n✅ Setup complete! .env updated.\n');
  console.log('Test your bot:   node notify.js');
  console.log('Add to cron:     0 0 * * * cd ' + __dirname + ' && node notify.js >> notify.log 2>&1');
  console.log('                 (0 0 UTC = 8am SGT)\n');
}

main().catch(e => { console.error('Setup failed:', e.message); process.exit(1); });
