// Open-goals formatting helpers. The morning push itself lives in
// morning_brief.js (goals + calendar + Blackboard).

const { formatDueLabel } = require('./due_date');

const STALE_MS = 14 * 86400000;

function goalTitle(goal) {
  return String(goal?.description || goal?.title || 'Untitled').trim() || 'Untitled';
}

function goalNextAction(goal) {
  const action = String(goal?.next_action?.action || '').trim();
  if (!action) return '';
  return action.toLowerCase() === goalTitle(goal).toLowerCase() ? '' : action;
}

function isStaleGoal(goal, nowMs = Date.now()) {
  const created = new Date(goal?.created_at).getTime();
  return Number.isFinite(created) && created <= nowMs - STALE_MS;
}

// Spoken + Telegram-friendly prose. Returns null when there's nothing to push
// so empty mornings stay quiet.
function formatDailyGoalsDigest(goals, { nowMs = Date.now(), timeZone = 'America/Phoenix' } = {}) {
  const open = (Array.isArray(goals) ? goals : [])
    .filter(goal => goal && goalTitle(goal));
  if (!open.length) return null;

  const items = open.map((goal, index) => {
    const title = goalTitle(goal);
    const dueLabel = formatDueLabel(goal.due_at, { timeZone, now: new Date(nowMs) });
    const stale = isStaleGoal(goal, nowMs) ? 'open over two weeks' : null;
    const tags = [dueLabel, stale].filter(Boolean);
    const suffix = tags.length ? `, ${tags.join(', ')}` : '';
    const next = goalNextAction(goal);
    return `${index + 1}) ${title}${suffix}${next ? ` — next: ${next}` : ''}`;
  });

  if (open.length === 1) {
    const dueLabel = formatDueLabel(open[0].due_at, { timeZone, now: new Date(nowMs) });
    const stale = isStaleGoal(open[0], nowMs);
    const extras = [dueLabel, stale ? 'been over two weeks' : null].filter(Boolean);
    const extraBit = extras.length ? ` (${extras.join(', ')})` : '';
    const next = goalNextAction(open[0]);
    return `Morning — you've got one thing on your list: ${goalTitle(open[0])}${extraBit}.${next ? ` Next move: ${next}.` : ''} Ask me anytime if you want to update or knock it out.`;
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

  // Telegram mirroring is owned by sendProactiveAlert when wired that way.
  // Keep an opt-in path for callers that pass sendTelegram explicitly.
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
  goalNextAction,
  goalTitle,
  isStaleGoal,
  phoenixDateKey,
  runDailyGoalsDigest
};
