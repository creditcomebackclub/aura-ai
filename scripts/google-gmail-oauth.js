#!/usr/bin/env node
'use strict';

// One-time helper for connecting AURA to the Gmail mailbox she should monitor.
// Calendar OAuth is intentionally excluded so changing inboxes cannot disturb the
// separately configured GOOGLE_CALENDAR_* account.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const dotenv = require('dotenv');

dotenv.config({ quiet: true });

const CLIENT_ID = process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://127.0.0.1:8787/callback';
const PORT = 8787;
const OUTPUT_PATH = path.resolve(process.cwd(), '.gmail-oauth-token.json');
const ENV_PATH = path.resolve(process.cwd(), '.env');
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send'
].join(' ');

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function setEnvValue(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  return pattern.test(contents)
    ? contents.replace(pattern, line)
    : `${contents.replace(/\s*$/, '')}\n${line}\n`;
}

function installLocalCredentials(credentials) {
  let contents = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  contents = setEnvValue(contents, 'EMAIL_PROVIDER', 'gmail');
  contents = setEnvValue(contents, 'GMAIL_CLIENT_ID', credentials.client_id);
  contents = setEnvValue(contents, 'GMAIL_CLIENT_SECRET', credentials.client_secret);
  contents = setEnvValue(contents, 'GMAIL_REFRESH_TOKEN', credentials.refresh_token);
  fs.writeFileSync(ENV_PATH, contents, { mode: 0o600 });
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  fail('Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env.');
}

function authUrl() {
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false'
  })}`;
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
  if (!response.ok) throw new Error(data.error_description || data.error || response.statusText);
  return data;
}

async function authenticatedEmail(accessToken) {
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error(`Gmail profile lookup failed (${response.status}).`);
  return (await response.json()).emailAddress;
}

async function main() {
  if (process.argv.includes('--install-existing')) {
    if (!fs.existsSync(OUTPUT_PATH)) fail(`No saved credentials found at ${OUTPUT_PATH}.`);
    const credentials = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    installLocalCredentials(credentials);
    console.log(`Local Gmail configuration now uses ${credentials.email}.`);
    return;
  }

  const url = authUrl();
  const server = http.createServer(async (req, res) => {
    const callback = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (callback.pathname !== '/callback') {
      res.writeHead(404).end('Not found');
      return;
    }

    try {
      const oauthError = callback.searchParams.get('error');
      if (oauthError) throw new Error(callback.searchParams.get('error_description') || oauthError);
      const code = callback.searchParams.get('code');
      if (!code) throw new Error('Google did not return an authorization code.');

      const tokens = await exchangeCode(code);
      if (!tokens.refresh_token) {
        throw new Error('Google did not return a refresh token. Remove this app from Google Account third-party access and try again.');
      }
      const email = await authenticatedEmail(tokens.access_token);
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
        email,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: tokens.refresh_token
      }, null, 2), { mode: 0o600 });
      installLocalCredentials({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: tokens.refresh_token
      });

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>Gmail connected</h1><p>AURA authenticated <strong>${email}</strong>. You can close this tab.</p>`);
      console.log(`\nGmail connected as ${email}. Local credentials were updated and a secure Render handoff was saved to ${OUTPUT_PATH}.`);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Gmail connection failed: ${error.message}`);
      console.error(`\nGmail connection failed: ${error.message}`);
      process.exitCode = 1;
    } finally {
      server.close();
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log([
      'AURA Gmail OAuth',
      '================',
      'Choose creditcomebackclub@gmail.com on the Google consent screen.',
      'Opening Google sign-in now...'
    ].join('\n'));
    const openCommand = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    require('child_process').exec(`${openCommand} "${url.replace(/"/g, '\\"')}"`, () => {});
  });
}

main();
