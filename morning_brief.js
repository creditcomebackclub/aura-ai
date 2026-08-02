// Combined morning push: open goals (with due dates), today's calendar, and
// near-term Blackboard deadlines — one readable Telegram/WebSocket message,
// plus a prose `spoken` string for optional voice playback.

const {
  formatDailyGoalsDigest,
  goalTitle,
  phoenixDateKey,
  STALE_MS
} = require('./daily_goals_digest');
const { formatDueLabel, isDueToday, isOverdue } = require('./due_date');

function ownerDisplayName(name) {
  const trimmed = String(name || '').trim();
  return trimmed || 'Chris';
}

function sortedOpenGoals(goals, { nowMs, timeZone }) {
  const open = (Array.isArray(goals) ? goals : []).filter(goal => goal && goalTitle(goal));
  return [...open].sort((left, right) => {
    const rank = (goal) => {
      if (isOverdue(goal.due_at, { now: new Date(nowMs) })) return 0;
      if (isDueToday(goal.due_at, { timeZone, now: new Date(nowMs) })) return 1;
      if (goal.due_at) return 2;
      return 3;
    };
    return rank(left) - rank(right);
  });
}

function formatGoalLine(goal, index, { nowMs, timeZone }) {
  const title = goalTitle(goal);
  const dueLabel = formatDueLabel(goal.due_at, { timeZone, now: new Date(nowMs) });
  const created = new Date(goal.created_at).getTime();
  const stale = Number.isFinite(created) && created <= nowMs - STALE_MS;
  const tags = [dueLabel, stale && !dueLabel ? 'open over two weeks' : null].filter(Boolean);
  const suffix = tags.length ? ` — ${tags.join(', ')}` : '';
  return `${index + 1}. ${title}${suffix}`;
}

function formatGoalsSection(goals, { nowMs, timeZone } = {}) {
  const sorted = sortedOpenGoals(goals, { nowMs, timeZone });
  if (!sorted.length) return null;
  const lines = sorted.map((goal, index) => formatGoalLine(goal, index, { nowMs, timeZone }));
  return [`Goals (${sorted.length})`, ...lines].join('\n');
}

function spokenGoalsSection(goals, { nowMs, timeZone } = {}) {
  const sorted = sortedOpenGoals(goals, { nowMs, timeZone });
  if (!sorted.length) return null;
  const bits = sorted.map(goal => {
    const dueLabel = formatDueLabel(goal.due_at, { timeZone, now: new Date(nowMs) });
    return dueLabel ? `${goalTitle(goal)}, ${dueLabel}` : goalTitle(goal);
  });
  if (bits.length === 1) return `On your list: ${bits[0]}.`;
  return `On your list, ${bits.length} things: ${bits.join('; ')}.`;
}

function cleanCalendarEventLine(line) {
  // "Event: Title @ place (Starts: Mon, Aug 3, 9:00 AM)" → "Title @ place — Mon, Aug 3, 9:00 AM"
  let text = String(line || '').trim().replace(/^Event:\s*/i, '');
  const startsMatch = text.match(/^(.*)\s*\(Starts:\s*(.+)\)\s*$/i);
  if (startsMatch) {
    const title = startsMatch[1].trim();
    const when = startsMatch[2].trim();
    return when ? `${title} — ${when}` : title;
  }
  return text;
}

function calendarEventLines(calendarText) {
  if (!calendarText || typeof calendarText !== 'string') return null;
  const trimmed = calendarText.trim();
  if (!trimmed) return null;
  if (/^no events scheduled/i.test(trimmed)) return [];
  return trimmed
    .split('\n')
    .map(line => cleanCalendarEventLine(line))
    .filter(Boolean)
    .slice(0, 5);
}

function formatCalendarSection(calendarText) {
  const lines = calendarEventLines(calendarText);
  if (lines == null) return null;
  if (!lines.length) return 'Calendar\nClear.';
  return ['Calendar', ...lines.map(line => `• ${line}`)].join('\n');
}

function spokenCalendarSection(calendarText) {
  const lines = calendarEventLines(calendarText);
  if (lines == null) return null;
  if (!lines.length) return 'Your calendar is clear.';
  // Em dashes read awkwardly aloud; use commas.
  const spokenLines = lines.map(line => line.replace(/\s*—\s*/g, ', '));
  return `On the calendar: ${spokenLines.join('; ')}.`;
}

function cleanBlackboardTitle(title) {
  return String(title || '')
    .replace(/\s*\[due\s+day\s+\d+\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function zonedDayParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type) => parts.find(part => part.type === type)?.value;
  return {
    weekday: get('weekday'),
    month: get('month'),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    dayKey: `${get('weekday')}|${get('month')}|${get('day')}`
  };
}

function formatBlackboardDayLabel(parts) {
  return `${parts.weekday}, ${parts.month} ${parts.day}`;
}

function blackboardItems(upcoming, { timeZone = 'America/Phoenix' } = {}) {
  return (Array.isArray(upcoming) ? upcoming : [])
    .slice(0, 8)
    .map(item => {
      const dueAt = item.due_at ? new Date(item.due_at) : null;
      const validDue = dueAt && Number.isFinite(dueAt.getTime()) ? dueAt : null;
      const parts = validDue ? zonedDayParts(validDue, timeZone) : null;
      return {
        title: cleanBlackboardTitle(item.title) || 'Untitled',
        parts,
        dueAt: validDue,
        // Academic deadlines are almost always 11:59pm — omit that noise.
        showTime: parts ? !(parts.hour === 23 && parts.minute === 59) : false
      };
    })
    .filter(item => item.title);
}

function groupBlackboardItems(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.parts ? item.parts.dayKey : 'soon';
    if (!groups.has(key)) {
      groups.set(key, {
        label: item.parts ? formatBlackboardDayLabel(item.parts) : 'Soon',
        items: []
      });
    }
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

function formatBlackboardSection(upcoming, { timeZone = 'America/Phoenix' } = {}) {
  const items = blackboardItems(upcoming, { timeZone });
  if (!items.length) return null;

  const lines = [`Blackboard (${items.length})`];
  for (const group of groupBlackboardItems(items)) {
    lines.push(group.label);
    for (const item of group.items) {
      if (item.showTime && item.dueAt) {
        const time = new Intl.DateTimeFormat('en-US', {
          timeZone,
          hour: 'numeric',
          minute: '2-digit'
        }).format(item.dueAt);
        lines.push(`• ${item.title} — ${time}`);
      } else {
        lines.push(`• ${item.title}`);
      }
    }
  }
  return lines.join('\n');
}

function spokenBlackboardSection(upcoming, { timeZone = 'America/Phoenix' } = {}) {
  const items = blackboardItems(upcoming, { timeZone });
  if (!items.length) return null;

  const groupBits = groupBlackboardItems(items).map(group => {
    const titles = group.items.map(item => {
      if (item.showTime && item.dueAt) {
        const time = new Intl.DateTimeFormat('en-US', {
          timeZone,
          hour: 'numeric',
          minute: '2-digit'
        }).format(item.dueAt);
        return `${item.title} at ${time}`;
      }
      return item.title;
    });
    return `on ${group.label}: ${titles.join('; ')}`;
  });

  return `Blackboard has ${items.length} deadline${items.length === 1 ? '' : 's'} ${groupBits.join('; ')}.`;
}

function buildMorningBrief({
  goals = [],
  calendarText = null,
  blackboardUpcoming = [],
  now = new Date(),
  timeZone = 'America/Phoenix',
  ownerName = 'Chris'
} = {}) {
  const nowMs = now.getTime();
  const name = ownerDisplayName(ownerName);
  const textSections = [
    formatGoalsSection(goals, { nowMs, timeZone }),
    formatCalendarSection(calendarText),
    formatBlackboardSection(blackboardUpcoming, { timeZone })
  ].filter(Boolean);
  const spokenSections = [
    spokenGoalsSection(goals, { nowMs, timeZone }),
    spokenCalendarSection(calendarText),
    spokenBlackboardSection(blackboardUpcoming, { timeZone })
  ].filter(Boolean);

  if (!textSections.length) return null;

  const text = [
    `Good morning, ${name}.`,
    '',
    textSections.join('\n\n'),
    '',
    'Ask me anytime if you want to knock something out.'
  ].join('\n');

  const spoken = [
    `Good morning, ${name}.`,
    ...spokenSections,
    'Ask me anytime if you want to knock something out.'
  ].join(' ');

  return { text, spoken };
}

function formatMorningBrief(options = {}) {
  return buildMorningBrief(options)?.text || null;
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
  now = new Date(),
  ownerName = process.env.AURA_OWNER_NAME || 'Chris'
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

  const brief = buildMorningBrief({
    goals,
    calendarText,
    blackboardUpcoming,
    now,
    timeZone,
    ownerName
  });
  if (!brief) {
    return { status: 'empty', sent: false, count: 0, errors };
  }

  const dedupeKey = `morning-brief:${phoenixDateKey(timeZone, now)}`;
  const notification = await sendAlert(brief.text, 'morning_brief', 'normal', {
    dedupeKey,
    spoken: brief.spoken,
    telegramVoice: true,
    metadata: { spoken: brief.spoken }
  });
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
  buildMorningBrief,
  formatMorningBrief,
  formatGoalsSection,
  formatCalendarSection,
  formatBlackboardSection,
  filterUpcomingAssignments,
  runMorningBrief,
  // Re-export for callers that still want goals-only formatting.
  formatDailyGoalsDigest
};
