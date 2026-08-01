const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDailyGoalsDigest,
  phoenixDateKey,
  runDailyGoalsDigest
} = require('../daily_goals_digest');

test('daily goals digest stays quiet when the list is empty', () => {
  assert.equal(formatDailyGoalsDigest([]), null);
  assert.equal(formatDailyGoalsDigest(null), null);
});

test('daily goals digest speaks a single open item naturally', () => {
  const text = formatDailyGoalsDigest([
    { title: 'Call the insurer', created_at: new Date().toISOString() }
  ]);
  assert.match(text, /one thing on your list: Call the insurer/i);
  assert.doesNotMatch(text, /1\)/);
});

test('daily goals digest lists several items and flags stale ones', () => {
  const now = Date.now();
  const text = formatDailyGoalsDigest([
    { description: 'Ship letters', created_at: new Date(now).toISOString() },
    { title: 'Follow up Karl', created_at: new Date(now - 20 * 86400000).toISOString() }
  ], { nowMs: now });
  assert.match(text, /2 things on your list/i);
  assert.match(text, /1\) Ship letters/);
  assert.match(text, /2\) Follow up Karl, open over two weeks/);
});

test('daily goals digest runner sends once, mirrors Telegram, and dedupes', async () => {
  const goals = [{ title: 'Pay rent', created_at: new Date().toISOString() }];
  const alerts = [];
  const telegrams = [];

  const first = await runDailyGoalsDigest({
    listOpenGoals: async () => goals,
    sendAlert: async (text, category, urgency, options) => {
      alerts.push({ text, category, urgency, options });
      return { id: 1, deduplicated: false };
    },
    sendTelegram: async (text) => { telegrams.push(text); },
    telegramConfigured: true,
    timeZone: 'America/Phoenix',
    now: new Date('2026-08-01T14:30:00Z')
  });
  assert.equal(first.status, 'sent');
  assert.equal(first.telegram.sent, true);
  assert.equal(alerts[0].category, 'goals');
  assert.equal(alerts[0].options.dedupeKey, `daily-goals:${phoenixDateKey('America/Phoenix', new Date('2026-08-01T14:30:00Z'))}`);
  assert.equal(telegrams.length, 1);

  const second = await runDailyGoalsDigest({
    listOpenGoals: async () => goals,
    sendAlert: async () => ({ deduplicated: true }),
    sendTelegram: async (text) => { telegrams.push(text); },
    telegramConfigured: true,
    now: new Date('2026-08-01T14:35:00Z')
  });
  assert.equal(second.status, 'deduplicated');
  assert.equal(telegrams.length, 1);
});
