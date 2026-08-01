// Combined morning push: open goals (with due dates), today's calendar, and
// near-term Blackboard deadlines — one spoken/Telegram message.

const {
  formatDailyGoalsDigest,
  goalTitle,
  phoenixDateKey,
  STALE_MS
} = require('./daily_goals_digest');
const { formatDueLabel, isDueToday, isOverdue } = require('./due_date');

function formatGoalLine(goal, index, { nowMs, timeZone }) {
  const title = goalTitle(goal);
  const dueLabel = formatDueLabel(goal.due_at, { timeZone, now: new Date(nowMs) });
  const created = new Date(goal.created_at).getTime();
  const stale = Number.isFinite(created) && created <= nowMs - STALE_MS;
  const tags = [dueLabel, stale && !dueLabel ? 'open over two weeks' : null].filter(Boolean);
  const suffix = tags.length ? `, ${tags.join(', ')}` : '';
  return `${index + 1}) ${title}${suffix}`;
}

function formatGoalsSection(goals, { nowMs, timeZone } = {}) {
  const open = (Array.isArray(goals) ? goals : []).filter(goal => goal && goalTitle(goal));
  if (!open.length) return null;

  // Due today / overdue first, then the rest.
  const sorted = [...open].sort((left, right) => {
    const rank = (goal) => {
      if (isOverdue(goal.due_at, { now: new Date(nowMs) })) return 0;
      if (isDueToday(goal.due_at, { timeZone, now: new Date(nowMs) })) return 1;
      if (goal.due_at) return 2;
      return 3;
    };
    return rank(left) - rank(right);
  });

  if (sorted.length === 1) {
    const dueLabel = formatDueLabel(sorted[0].due_at, { timeZone, now: new Date(nowMs) });
    const dueBit = dueLabel ? ` (${dueLabel})` : '';
    return `On your list: ${goalTitle(sorted[0])}${dueBit}.`;
  }

  const items = sorted.map((goal, index) => formatGoalLine(goal, index, { nowMs, timeZone }));
  return `On your list (${sorted.length}): ${items.join('; ')}.`;
}

function formatCalendarSection(calendarText) {
  if (!calendarText || typeof calendarText !== 'string') return null;
  const trimmed = calendarText.trim();
  if (!trimmed) return null;
  if (/^no events scheduled/i.test(trimmed)) return 'Calendar is clear today.';
  // Compact: keep first few event lines.
  const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 5);
  if (!lines.length) return null;
  return `Today on the calendar: ${lines.map(line => line.replace(/^Event:\s*/i, '')).join('; ')}.`;
}

function formatBlackboardSection(upcoming, { timeZone = 'America/Phoenix' } = {}) {
  const items = Array.isArray(upcoming) ? upcoming : [];
  if (!items.length) return null;
  const dueFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
  const list = items.slice(0, 5).map(item => {
    const due = item.due_at ? dueFormatter.format(new Date(item.due_at)) : 'soon';
    return `${item.title}, due ${due}`;
  }).join('; ');
  return `Blackboard: ${items.length} deadline${items.length === 1 ? '' : 's'} in the next three days — ${list}.`;
}

function formatMorningBrief({
  goals = [],
  calendarText = null,
  blackboardUpcoming = [],
  now = new Date(),
  timeZone = 'America/Phoenix'
} = {}) {
  const nowMs = now.getTime();
  const sections = [
    formatGoalsSection(goals, { nowMs, timeZone }),
    formatCalendarSection(calendarText),
    formatBlackboardSection(blackboardUpcoming, { timeZone })
  ].filter(Boolean);

  if (!sections.length) return null;
  return `Morning. ${sections.join(' ')} Ask me anytime if you want to knock something out.`;
}

function filterUpcomingAssignments(assignments, { now = new Date(), withinDays = 3 } = {}) {
  const currentTimestamp = now.getTime();
  const cutoff = currentTimestamp + withinDays * 86400000;
  return (Array.isArray(assignments) ? assignments : [])
    .filter(item => {
      const due = new Date(item.due_at).getTime();
      return Number.isFinite(due) && due >= currentTimestamp && due <= cutoff;
    })
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
}

async function runMorningBrief({
  listOpenGoals,
  getCalendarText,
  getBlackboardUpcoming,
  sendAlert,
  timeZone = 'America/Phoenix',
  now = new Date()
} = {}) {
  if (typeof listOpenGoals !== 'function' || typeof sendAlert !== 'function') {
    throw new Error('runMorningBrief requires listOpenGoals and sendAlert.');
  }

  const goals = await listOpenGoals();
  let calendarText = null;
  let blackboardUpcoming = [];
  const errors = [];

  if (typeof getCalendarText === 'function') {
    try {
      calendarText = await getCalendarText();
    } catch (error) {
      errors.push(`calendar:${error.message || error}`);
    }
  }
  if (typeof getBlackboardUpcoming === 'function') {
    try {
      blackboardUpcoming = await getBlackboardUpcoming() || [];
    } catch (error) {
      errors.push(`blackboard:${error.message || error}`);
    }
  }

  const text = formatMorningBrief({
    goals,
    calendarText,
    blackboardUpcoming,
    now,
    timeZone
  });
  if (!text) {
    return { status: 'empty', sent: false, count: 0, errors };
  }

  const dedupeKey = `morning-brief:${phoenixDateKey(timeZone, now)}`;
  const notification = await sendAlert(text, 'morning_brief', 'normal', { dedupeKey });
  if (notification?.deduplicated) {
    return {
      status: 'deduplicated',
      sent: false,
      count: goals.length,
      dedupeKey,
      errors
    };
  }

  return {
    status: 'sent',
    sent: true,
    count: goals.length,
    calendar: Boolean(calendarText),
    blackboard: blackboardUpcoming.length,
    dedupeKey,
    errors
  };
}

module.exports = {
  formatMorningBrief,
  formatGoalsSection,
  formatCalendarSection,
  formatBlackboardSection,
  filterUpcomingAssignments,
  runMorningBrief,
  // Re-export for callers that still want goals-only formatting.
  formatDailyGoalsDigest
};
