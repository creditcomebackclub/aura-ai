#!/usr/bin/env node
'use strict';

// One-time helper: get a Google refresh token for Calendar event read/write
// plus Gmail read/send. The same grant supports direct commands and the
// proactive Executive Loop.
//
// Usage (on your Mac, in the repo):
//   1. Put GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env (or export them)
//   2. node scripts/google-calendar-oauth.js
//   3. Browser opens → sign in as Chris → Allow
//   4. Copy the printed refresh token into Render
//
// Before running, in Google Cloud Console (same project as your OAuth client):
//   • APIs & Services → Library → enable "Google Calendar API"
//   • APIs & Services → Credentials → your OAuth client → Authorized redirect URIs:
//       http://127.0.0.1:8787/callback
//   • OAuth consent screen → Scopes → add ".../auth/calendar.events" if listed

const http = require('http');
const { URL } = require('url');
const dotenv = require('dotenv');

dotenv.config();

const CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID ||
  process.env.GMAIL_CLIENT_ID ||
  process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET ||
  process.env.GMAIL_CLIENT_SECRET ||
  process.env.GOOGLE_CLIENT_SECRET;

const REDIRECT_URI = 'http://127.0.0.1:8787/callback';
const PORT = 8787;

// One grant for Calendar event read/write plus Gmail read/send.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send'
].join(' ');

function die(message) {
  console.error('\n' + message + '\n');
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  die([
    'Missing OAuth client credentials.',
    'Add to .env (or export):',
    '  GMAIL_CLIENT_ID=....apps.googleusercontent.com',
    '  GMAIL_CLIENT_SECRET=....',
    '',
    'Use the same OAuth client you already use for Gmail, from:',
    '  https://console.cloud.google.com/apis/credentials'
  ].join('\n'));
}

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || response.statusText);
  }
  return data;
}

function printSuccess(tokens) {
  if (!tokens.refresh_token) {
    console.log([
      '\n⚠️  Google did not return a refresh_token.',
      'That usually means this account already authorized this app without prompt=consent.',
      'Fix: Google Account → Security → Third-party access → remove this app, then run again.',
      '',
      'Access token (short-lived, not what Render needs):',
      tokens.access_token
    ].join('\n'));
    return;
  }

  console.log('\n✅ Success. Add these on Render → aura-brain → Environment:\n');
  console.log('GOOGLE_CALENDAR_CLIENT_ID=' + CLIENT_ID);
  console.log('GOOGLE_CALENDAR_CLIENT_SECRET=' + CLIENT_SECRET);
  console.log('GOOGLE_CALENDAR_REFRESH_TOKEN=' + tokens.refresh_token);
  console.log('GOOGLE_CALENDAR_ID=primary');
  console.log('\nThen redeploy. Test: ask AURA to schedule something; a clear command executes immediately.\n');
  console.log('(Optional: you can put the same three values in GMAIL_* instead if you prefer one token for mail+calendar.)\n');
}

async function main() {
  const authUrl = buildAuthUrl();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Google returned an error: ' + error);
      console.error('\nGoogle error:', error, url.searchParams.get('error_description') || '');
      server.close();
      process.exit(1);
    }

    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing code');
      return;
    }

    try {
      const tokens = await exchangeCode(code);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Done — check your terminal for the refresh token.</h1><p>You can close this tab.</p>');
      printSuccess(tokens);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Token exchange failed: ' + err.message);
      console.error('\nToken exchange failed:', err.message);
    } finally {
      server.close();
      process.exit(0);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log([
      'Google Calendar + Executive Loop — OAuth setup',
      '===================================',
      '',
      'Step A (once, in browser): https://console.cloud.google.com',
      '  1. APIs & Services → Library → search "Google Calendar API" → Enable',
      '  2. APIs & Services → Credentials → your OAuth 2.0 Client ID',
      '  3. Authorized redirect URIs → Add URI → paste exactly:',
      '       ' + REDIRECT_URI,
      '  4. Save',
      '',
      'Step B (this script):',
      '  Opening sign-in in 2 seconds. If it does not open, paste this URL:',
      '',
      authUrl,
      ''
    ].join('\n'));

    const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    setTimeout(() => {
      require('child_process').exec(`${openCmd} "${authUrl.replace(/"/g, '\\"')}"`, () => {});
    }, 2000);
  });
}

main().catch(err => die(err.message));
