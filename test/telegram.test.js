const test = require('node:test');
const assert = require('node:assert/strict');
const { isTelegramConfigured, isFromOwnerChat } = require('../telegram');

function withEnv(overrides, fn) {
  const original = {};
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test('isTelegramConfigured requires both bot token and chat id', () => {
  withEnv({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }, () => {
    assert.equal(isTelegramConfigured(), false);
  });
  withEnv({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: undefined }, () => {
    assert.equal(isTelegramConfigured(), false);
  });
  withEnv({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '12345' }, () => {
    assert.equal(isTelegramConfigured(), true);
  });
});

test('isFromOwnerChat is the inbound half of the same fixed-chat guarantee as sendTelegramMessage', () => {
  // This is the allowlist the webhook route uses to decide whether to ever
  // process an incoming message at all - it must reject anything that
  // isn't an exact match, including type-juggling tricks (numeric vs
  // string chat ids, which Telegram updates can send as either).
  withEnv({ TELEGRAM_CHAT_ID: '8776420089' }, () => {
    assert.equal(isFromOwnerChat('8776420089'), true);
    assert.equal(isFromOwnerChat(8776420089), true);
    assert.equal(isFromOwnerChat('8776420090'), false);
    assert.equal(isFromOwnerChat('some-attacker-chat'), false);
    assert.equal(isFromOwnerChat(''), false);
    assert.equal(isFromOwnerChat(null), false);
    assert.equal(isFromOwnerChat(undefined), false);
  });
  withEnv({ TELEGRAM_CHAT_ID: undefined }, () => {
    // With no configured chat id, a real (non-empty) incoming chat id must
    // never match. This scenario can't actually reach the webhook route in
    // practice anyway - isTelegramConfigured() requires TELEGRAM_CHAT_ID to
    // be set at all, and the route checks that first - but isFromOwnerChat
    // itself should still fail closed if ever called without one.
    assert.equal(isFromOwnerChat('8776420089'), false);
    assert.equal(isFromOwnerChat('undefined'), false);
  });
});
