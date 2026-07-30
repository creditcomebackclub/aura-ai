// Minimal raw-fetch client for the Telegram Bot API - no SDK dependency,
// matching how the rest of this codebase talks to external HTTP APIs
// (Cartesia is called the same way). Chat id is fixed from config, never
// supplied by the model, for the same reason the email recipient is fixed:
// there is no path for this to reach anyone but the owner.

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

module.exports = { isTelegramConfigured, sendTelegramMessage };
