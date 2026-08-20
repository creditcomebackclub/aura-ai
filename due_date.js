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

function parseClock(input) {
  const value = String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (value === 'noon') return { hour: 12, minute: 0 };
  if (value === 'midnight') return { hour: 0, minute: 0 };
  const match = value.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/);
  if (!match) return null;
  let hour = Number(match[1]);
  if (hour < 1 || hour > 12) return null;
  if (match[3] === 'am') hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;
  return { hour, minute: Number(match[2] || 0) };
}

function parseDueAt(input, { timeZone = 'America/Phoenix', now = new Date() } = {}) {
  if (input == null || input === '') return null;
  if (input instanceof Date && Number.isFinite(input.getTime())) return input.toISOString();

  const raw = String(input).trim();
  if (!raw) return null;

  // A full timestamp already carries its own offset - take it as given.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) {
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }

  // A bare YYYY-MM-DD has no time and no zone. `new Date('2026-08-25')` is
  // UTC midnight, which in Phoenix is 5pm on the 24th - so a date-only due
  // date landed on the PREVIOUS local day and every such goal read as
  // overdue on the morning it was actually due. Route it through the same
  // end-of-local-day rule the relative phrases already use.
  const isoDateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateOnly) {
    const year = Number(isoDateOnly[1]);
    const month = Number(isoDateOnly[2]);
    const day = Number(isoDateOnly[3]);
    // Date.UTC rolls impossible values over rather than rejecting them, so
    // "2026-13-45" would silently become a real date next year. Before this
    // branch existed, new Date() returned NaN and the caller reported a parse
    // failure; keep that behaviour rather than storing a wrong due date.
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
    const end = endOfLocalDay(year, month, day, timeZone);
    if (Number.isFinite(end.getTime())) return end.toISOString();
  }

  const lower = raw.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = zonedParts(now, timeZone);

  const timed = lower.replace(/^every\s+/, '').match(
    /^(today|tomorrow|(?:next\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)|in\s+\d+\s+days?)\s+at\s+(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)|noon|midnight)$/
  );
  if (timed) {
    const clock = parseClock(timed[2]);
    if (!clock) return null;
    const weekdayName = timed[1].toLowerCase();
    const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    if (!weekdayName.startsWith('next ') && Object.hasOwn(WEEKDAYS, weekdayName) &&
        WEEKDAYS[weekdayName] === weekdayIndex) {
      const todayAtTime = utcFromZoned(
        parts.year,
        parts.month,
        parts.day,
        clock.hour,
        clock.minute,
        timeZone
      );
      if (todayAtTime.getTime() > now.getTime()) return todayAtTime.toISOString();
    }
    const dateOnly = parseDueAt(timed[1], { timeZone, now });
    if (!dateOnly) return null;
    const target = zonedParts(new Date(dateOnly), timeZone);
    return utcFromZoned(
      target.year,
      target.month,
      target.day,
      clock.hour,
      clock.minute,
      timeZone
    ).toISOString();
  }

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
    // A bare weekday means the next one to come round. "next <weekday>" means
    // that weekday in the FOLLOWING calendar week, which is not the same
    // thing: said on a Wednesday, "next Friday" is nine days out, not two.
    // The old form (`delta === 0 || weekdayHit[1]`) only changed anything
    // when delta was already 0, so the "next " prefix was silently ignored on
    // every other day of the week and those goals came due a week early.
    let delta;
    if (weekdayHit[1]) {
      // Days to the start (Sunday) of next week, then out to the weekday.
      delta = (7 - weekdayIndex) + want;
    } else {
      delta = (want - weekdayIndex + 7) % 7;
      if (delta === 0) delta = 7;
    }
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
  parseClock,
  isDueToday,
  isOverdue,
  formatDueLabel,
  zonedParts
};
