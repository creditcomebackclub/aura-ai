'use strict';

// Open-window finder over events the caller already fetched.
//
// The Executive Loop pulls a week of calendar events every run, so suggesting
// times costs no extra API call — this is a pure function over that same list.
// Timezone math reuses calendar_time.js so business hours mean the same thing
// here as they do everywhere else in AURA.

const { addDateKeyDays, dateKey, utcFromZoned, zonedParts } = require('./calendar_time');

const DEFAULT_BUSINESS_START_HOUR = 9;
const DEFAULT_BUSINESS_END_HOUR = 17;
const DEFAULT_MIN_MINUTES = 30;
const DEFAULT_LOOKAHEAD_DAYS = 7;
const DEFAULT_LEAD_MINUTES = 120;
const DEFAULT_MAX_WINDOWS = 3;
const MAX_LOOKAHEAD_DAYS = 21;

function eventInterval(event) {
  const startRaw = event?.start?.dateTime || event?.start?.date;
  const endRaw = event?.end?.dateTime || event?.end?.date;
  if (!startRaw) return null;
  const start = new Date(startRaw).getTime();
  if (!Number.isFinite(start)) return null;
  // An all-day entry blocks the whole day; a timed entry with no end gets the
  // Google default of one hour.
  const allDay = Boolean(event?.start?.date && !event?.start?.dateTime);
  let end = endRaw ? new Date(endRaw).getTime() : NaN;
  if (!Number.isFinite(end)) end = start + (allDay ? 86400000 : 3600000);
  if (end <= start) end = start + (allDay ? 86400000 : 3600000);
  return { start, end, allDay };
}

// Events that do not actually consume the owner's time.
function blocksTime(event) {
  if (!event || event.status === 'cancelled') return false;
  if (event.transparency === 'transparent') return false;
  const selfAttendee = (event.attendees || []).find(attendee => attendee?.self);
  if (selfAttendee && selfAttendee.responseStatus === 'declined') return false;
  return true;
}

function busyIntervals(events = []) {
  const intervals = (Array.isArray(events) ? events : [])
    .filter(blocksTime)
    .map(eventInterval)
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);

  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      continue;
    }
    merged.push({ ...interval });
  }
  return merged;
}

// Subtracts busy intervals from one business-hours span.
function subtractBusy(spanStart, spanEnd, busy, minMs) {
  const windows = [];
  let cursor = spanStart;
  for (const interval of busy) {
    if (interval.end <= cursor) continue;
    if (interval.start >= spanEnd) break;
    if (interval.start - cursor >= minMs) {
      windows.push({ start: cursor, end: interval.start });
    }
    cursor = Math.max(cursor, interval.end);
    if (cursor >= spanEnd) break;
  }
  if (spanEnd - cursor >= minMs) windows.push({ start: cursor, end: spanEnd });
  return windows;
}

function formatWindow(window, timeZone) {
  const start = new Date(window.start);
  const end = new Date(window.end);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  }).format(start);
  const time = value => new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit'
  }).format(value).replace(':00', '');
  const startLabel = time(start);
  const endLabel = time(end);
  // "Thursday, Aug 20 3–5 PM" — drop the duplicated meridiem on the start.
  const meridiem = /(AM|PM)$/i.exec(startLabel)?.[1];
  const endMeridiem = /(AM|PM)$/i.exec(endLabel)?.[1];
  const compactStart = meridiem && meridiem === endMeridiem
    ? startLabel.replace(/\s*(AM|PM)$/i, '')
    : startLabel;
  return `${day} ${compactStart}–${endLabel}`;
}

// Returns the open business-hours windows over the lookahead period.
function findOpenWindows(events = [], {
  now = new Date(),
  timeZone = 'America/Phoenix',
  businessStartHour = DEFAULT_BUSINESS_START_HOUR,
  businessEndHour = DEFAULT_BUSINESS_END_HOUR,
  minMinutes = DEFAULT_MIN_MINUTES,
  lookaheadDays = DEFAULT_LOOKAHEAD_DAYS,
  leadMinutes = DEFAULT_LEAD_MINUTES,
  includeWeekends = false,
  maxWindows = DEFAULT_MAX_WINDOWS
} = {}) {
  const startHour = Math.max(0, Math.min(23, Number(businessStartHour) || DEFAULT_BUSINESS_START_HOUR));
  const endHour = Math.max(startHour + 1, Math.min(24, Number(businessEndHour) || DEFAULT_BUSINESS_END_HOUR));
  const minMs = Math.max(5, Number(minMinutes) || DEFAULT_MIN_MINUTES) * 60000;
  const days = Math.max(1, Math.min(MAX_LOOKAHEAD_DAYS, Number(lookaheadDays) || DEFAULT_LOOKAHEAD_DAYS));
  const earliest = now.getTime() + Math.max(0, Number(leadMinutes) || 0) * 60000;
  const busy = busyIntervals(events);

  const windows = [];
  let key = dateKey(zonedParts(now, timeZone));
  for (let offset = 0; offset < days && windows.length < maxWindows; offset += 1) {
    const [year, month, day] = key.split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;
    if (includeWeekends || !isWeekend) {
      const spanStart = Math.max(
        earliest,
        utcFromZoned(year, month, day, startHour, 0, 0, timeZone).getTime()
      );
      const spanEnd = endHour >= 24
        ? utcFromZoned(year, month, day + 1, 0, 0, 0, timeZone).getTime()
        : utcFromZoned(year, month, day, endHour, 0, 0, timeZone).getTime();
      if (spanEnd - spanStart >= minMs) {
        for (const window of subtractBusy(spanStart, spanEnd, busy, minMs)) {
          if (windows.length >= maxWindows) break;
          windows.push({
            start: new Date(window.start).toISOString(),
            end: new Date(window.end).toISOString(),
            minutes: Math.round((window.end - window.start) / 60000),
            label: formatWindow(window, timeZone)
          });
        }
      }
    }
    key = addDateKeyDays(key, 1);
  }
  return windows;
}

function describeOpenWindows(windows = []) {
  const list = (Array.isArray(windows) ? windows : []).map(window => window.label).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')}, or ${list[list.length - 1]}`;
}

module.exports = {
  DEFAULT_BUSINESS_END_HOUR,
  DEFAULT_BUSINESS_START_HOUR,
  DEFAULT_LEAD_MINUTES,
  DEFAULT_LOOKAHEAD_DAYS,
  DEFAULT_MAX_WINDOWS,
  DEFAULT_MIN_MINUTES,
  MAX_LOOKAHEAD_DAYS,
  blocksTime,
  busyIntervals,
  describeOpenWindows,
  eventInterval,
  findOpenWindows,
  formatWindow,
  subtractBusy
};
