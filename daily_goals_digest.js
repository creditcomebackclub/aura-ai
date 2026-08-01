// Morning open-goals push. Pure formatting lives here so tests don't boot
// Express; the runner is injected with list/send deps from server.js.

const STALE_MS = 14 * 86400000;

function goalTitle(goal) {
  return String(goal?.description || goal?.title || 'Untitled').trim() || 'Untitled';
}

function isStaleGoal(goal, nowMs = Date.now()) {
  const created = new Date(goal?.created_at).getTime();
  return Number.isFinite(created) && created <= nowMs - STALE_MS;
}

// Spoken + Telegram-friendly prose. Returns null when there's nothing to push
// so empty mornings stay quiet.
function formatDailyGoalsDigest(goals, { nowMs = Date.now() } = {}) {
  const open = (Array.isArray(goals) ? goals : [])
    .filter(goal => goal && goalTitle(goal));
  if (!open.length) return null;

  const items = open.map((goal, index) => {
    const title = goalTitle(goal);
    const stale = isStaleGoal(goal, nowMs) ? ', open over two weeks' : '';
    return `${index + 1}) ${title}${stale}`;
  });

  if (open.length === 1) {
    const stale = isStaleGoal(open[0], nowMs) ? " It's been open over two weeks." : '';
    return `Morning — you've got one thing on your list: ${goalTitle(open[0])}.${stale} Ask me anytime if you want to update or knock it out.`;
  }

  return `Morning — you've got ${open.length} things on your list: ${items.join('; ')}. Ask me anytime if you want to update or knock any out.`;
}

function phoenixDateKey(timeZone = 'America/Phoenix', now = new Date()) {
  // en-CA → YYYY-MM-DD, stable for dedupe keys across restarts.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

async function runDailyGoalsDigest({
  listOpenGoals,
  sendAlert,
  sendTelegram = null,
  telegramConfigured = false,
  timeZone = 'America/Phoenix',
  now = new Date()
} = {}) {
  if (typeof listOpenGoals !== 'function' || typeof sendAlert !== 'function') {
    throw new Error('runDailyGoalsDigest requires listOpenGoals and sendAlert.');
  }

  const goals = await listOpenGoals();
  const text = formatDailyGoalsDigest(goals, { nowMs: now.getTime() });
  if (!text) {
    return { status: 'empty', sent: false, count: 0 };
  }

  const dedupeKey = `daily-goals:${phoenixDateKey(timeZone, now)}`;
  const notification = await sendAlert(text, 'goals', 'normal', { dedupeKey });
  if (notification?.deduplicated) {
    return { status: 'deduplicated', sent: false, count: goals.length, dedupeKey };
  }

  let telegram = { attempted: false, sent: false };
  if (telegramConfigured && typeof sendTelegram === 'function') {
    telegram.attempted = true;
    try {
      await sendTelegram(text);
      telegram.sent = true;
    } catch (error) {
      telegram.error = error.message || String(error);
      console.warn('[Daily goals] Telegram delivery failed:', telegram.error);
    }
  }

  return {
    status: 'sent',
    sent: true,
    count: goals.length,
    dedupeKey,
    telegram
  };
}

module.exports = {
  STALE_MS,
  formatDailyGoalsDigest,
  goalTitle,
  isStaleGoal,
  phoenixDateKey,
  runDailyGoalsDigest
};
