// Minimal raw-fetch client for the Telegram Bot API - no SDK dependency,
// matching how the rest of this codebase talks to external HTTP APIs
// (Cartesia is called the same way). Chat id is fixed from config, never
// supplied by the model, for the same reason the email recipient is fixed:
// there is no path for this to reach anyone but the owner.

const path = require('path');

function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).');

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text || '').slice(0, 4000) })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Telegram API error: ${response.status} - ${errText}`);
  }
  return true;
}

// Inbound side of the same fixed-chat guarantee as sendTelegramMessage: a
// message is only ever processed if it comes from TELEGRAM_CHAT_ID - this
// function itself doesn't enforce that (the webhook route does, since it
// needs to decide whether to respond at all), it's just the plain equality
// check the route calls, kept here so both directions of the Telegram
// integration live in one file.
function isFromOwnerChat(chatId) {
  return String(chatId) === String(process.env.TELEGRAM_CHAT_ID || '');
}

// Downloads a Telegram-hosted file (e.g. a voice note) given its file_id.
// Two-step API: getFile resolves file_id -> a relative file_path, then the
// actual bytes are fetched from a separate file-serving host.
async function downloadTelegramFile(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram is not configured (TELEGRAM_BOT_TOKEN).');

  const metaResponse = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!metaResponse.ok) throw new Error(`Telegram getFile failed: ${metaResponse.status}`);
  const meta = await metaResponse.json();
  const filePath = meta?.result?.file_path;
  if (!filePath) throw new Error('Telegram getFile returned no file_path.');

  const fileResponse = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!fileResponse.ok) throw new Error(`Telegram file download failed: ${fileResponse.status}`);
  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  const ext = path.extname(filePath) || '.oga';
  return { buffer, ext };
}

module.exports = { isTelegramConfigured, sendTelegramMessage, isFromOwnerChat, downloadTelegramFile };
