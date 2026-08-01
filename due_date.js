// Lightweight due-date parsing for goal tools. Accepts ISO dates and a small
// set of relative phrases the model (or owner) commonly uses in voice.

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type) => parts.find(part => part.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: get('weekday'),
    hour: Number(get('hour')),
    minute: Number(get('minute'))
  };
}

function utcFromZoned(year, month, day, hour, minute, timeZone) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(new Date(utc), timeZone);
    const deltaMin =
      ((year - parts.year) * 525600) +
      ((month - parts.month) * 43200) +
      ((day - parts.day) * 1440) +
      ((hour - parts.hour) * 60) +
      (minute - parts.minute);
    if (deltaMin === 0) break;
    utc += deltaMin * 60 * 1000;
  }
  return new Date(utc);
}

const WEEKDAYS = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2, tues: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4, thur: 4, thurs: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6
};

function endOfLocalDay(year, month, day, timeZone) {
  return utcFromZoned(year, month, day, 17, 0, timeZone); // 5pm local default
}

function addLocalDays(parts, days, timeZone) {
  const noon = utcFromZoned(parts.year, parts.month, parts.day, 12, 0, timeZone);
  const shifted = new Date(noon.getTime() + days * 86400000);
  const next = zonedParts(shifted, timeZone);
  return endOfLocalDay(next.year, next.month, next.day, timeZone);
}

function parseDueAt(input, { timeZone = 'America/Phoenix', now = new Date() } = {}) {
  if (input == null || input === '') return null;
  if (input instanceof Date && Number.isFinite(input.getTime())) return input.toISOString();

  const raw = String(input).trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }

  const lower = raw.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = zonedParts(now, timeZone);

  if (lower === 'today') {
    return endOfLocalDay(parts.year, parts.month, parts.day, timeZone).toISOString();
  }
  if (lower === 'tomorrow') {
    return addLocalDays(parts, 1, timeZone).toISOString();
  }

  const inDays = lower.match(/^in\s+(\d+)\s+days?$/);
  if (inDays) {
    return addLocalDays(parts, Number(inDays[1]), timeZone).toISOString();
  }

  if (lower === 'next week') {
    return addLocalDays(parts, 7, timeZone).toISOString();
  }

  const weekdayHit = lower.match(/^(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)$/);
  if (weekdayHit) {
    const want = WEEKDAYS[weekdayHit[2]];
    const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    let delta = (want - weekdayIndex + 7) % 7;
    if (delta === 0 || weekdayHit[1]) delta = delta === 0 ? 7 : delta;
    return addLocalDays(parts, delta, timeZone).toISOString();
  }

  return null;
}

function isDueToday(dueAt, { timeZone = 'America/Phoenix', now = new Date() } = {}) {
  if (!dueAt) return false;
  const due = new Date(dueAt);
  if (!Number.isFinite(due.getTime())) return false;
  const today = zonedParts(now, timeZone);
  const target = zonedParts(due, timeZone);
  return today.year === target.year && today.month === target.month && today.day === target.day;
}

function isOverdue(dueAt, { now = new Date() } = {}) {
  if (!dueAt) return false;
  const due = new Date(dueAt);
  return Number.isFinite(due.getTime()) && due.getTime() < now.getTime();
}

function formatDueLabel(dueAt, { timeZone = 'America/Phoenix', now = new Date() } = {}) {
  if (!dueAt) return null;
  const due = new Date(dueAt);
  if (!Number.isFinite(due.getTime())) return null;
  if (isDueToday(dueAt, { timeZone, now })) return 'due today';
  if (isOverdue(dueAt, { now })) return 'overdue';
  return `due ${new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  }).format(due)}`;
}

module.exports = {
  parseDueAt,
  isDueToday,
  isOverdue,
  formatDueLabel,
  zonedParts
};
