// Cloud-readable personal calendar via a private iCal URL (Google Calendar
// "secret address", Calendly export, etc.). Same shape as Blackboard's feed
// path: secret HTTPS URL → fetch → parse → spoken/tool text. No Mac required.

const { isIcsCalendar, parseIcsDate } = require('./scraper');

function calendarFeedUrl() {
  const raw = process.env.CALENDAR_ICAL_URL || process.env.GOOGLE_CALENDAR_ICAL_URL || '';
  return String(raw).trim();
}

function isDirectCalendarConfigured() {
  return Boolean(calendarFeedUrl());
}

function unfoldIcs(text) {
  return String(text).replace(/\r?\n[ \t]/g, '');
}

function decodeIcsText(value = '') {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function zonedDayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function addLocalDays(dayKey, days, timeZone) {
  // dayKey is YYYY-MM-DD in the owner's zone. Shift via noon UTC-ish then re-key
  // so DST edges don't drop a day.
  const [year, month, day] = dayKey.split('-').map(Number);
  const noonUtc = Date.UTC(year, month - 1, day, 12, 0, 0);
  const shifted = new Date(noonUtc + days * 86400000);
  return zonedDayKey(shifted, timeZone);
}

function parsePersonalIcs(text, { timeZone = 'America/Phoenix' } = {}) {
  const unfolded = unfoldIcs(text);
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  return blocks.map(block => {
    const fields = {};
    const fieldParameters = {};
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      const rawKey = line.slice(0, separator);
      const key = rawKey.split(';')[0].toUpperCase();
      if (!fields[key]) {
        fields[key] = line.slice(separator + 1);
        fieldParameters[key] = Object.fromEntries(
          rawKey.split(';').slice(1).map(parameter => {
            const equals = parameter.indexOf('=');
            if (equals < 0) return [parameter.toUpperCase(), ''];
            return [
              parameter.slice(0, equals).toUpperCase(),
              parameter.slice(equals + 1)
            ];
          })
        );
      }
    }

    // Skip cancelled events when STATUS is present.
    if (String(fields.STATUS || '').toUpperCase() === 'CANCELLED') return null;

    const startParams = fieldParameters.DTSTART || {};
    const start = parseIcsDate(
      fields.DTSTART,
      startParams.TZID || timeZone
    );
    if (!start) return null;

    const end = fields.DTEND
      ? parseIcsDate(fields.DTEND, fieldParameters.DTEND?.TZID || timeZone)
      : null;

    // Date-only DTSTART (YYYYMMDD, no time) → all-day.
    const allDay = Boolean(fields.DTSTART && !/T/.test(fields.DTSTART));

    return {
      title: decodeIcsText(fields.SUMMARY || 'Untitled event'),
      start_at: start.toISOString(),
      end_at: end ? end.toISOString() : null,
      all_day: allDay,
      location: decodeIcsText(fields.LOCATION || '')
    };
  }).filter(Boolean).sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
}

function eventsForTodayAndTomorrow(events, {
  now = new Date(),
  timeZone = 'America/Phoenix'
} = {}) {
  const todayKey = zonedDayKey(now, timeZone);
  const tomorrowKey = addLocalDays(todayKey, 1, timeZone);
  return (Array.isArray(events) ? events : []).filter(event => {
    const key = zonedDayKey(new Date(event.start_at), timeZone);
    return key === todayKey || key === tomorrowKey;
  });
}

function formatEventStart(event, { timeZone = 'America/Phoenix' } = {}) {
  const start = new Date(event.start_at);
  if (event.all_day) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    }).format(start) + ' (all day)';
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(start);
}

function formatCalendarEvents(events, { timeZone = 'America/Phoenix' } = {}) {
  if (!events.length) return 'No events scheduled for today.';
  return events.map(event => {
    const where = event.location ? ` @ ${event.location}` : '';
    return `Event: ${event.title}${where} (Starts: ${formatEventStart(event, { timeZone })})`;
  }).join('\n');
}

async function fetchCalendarIcs(feedUrl, { fetchImpl = fetch } = {}) {
  const normalizedUrl = String(feedUrl).replace(/^webcal:/i, 'https:');
  if (!/^https:\/\//i.test(normalizedUrl)) {
    throw new Error('The configured calendar URL must use HTTPS or webcal.');
  }
  const response = await fetchImpl(normalizedUrl, {
    headers: { 'User-Agent': 'AURA Calendar/1.0' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    throw new Error(`Calendar feed returned HTTP ${response.status}.`);
  }
  const calendarText = await response.text();
  if (!isIcsCalendar(calendarText)) {
    throw new Error('Calendar feed did not return iCalendar data.');
  }
  return calendarText;
}

async function getDirectCalendarText({
  now = new Date(),
  timeZone = process.env.AURA_TIMEZONE || 'America/Phoenix',
  fetchImpl = fetch
} = {}) {
  const feedUrl = calendarFeedUrl();
  if (!feedUrl) {
    throw new Error('No personal calendar feed is configured.');
  }
  try {
    const ics = await fetchCalendarIcs(feedUrl, { fetchImpl });
    const events = eventsForTodayAndTomorrow(
      parsePersonalIcs(ics, { timeZone }),
      { now, timeZone }
    );
    return formatCalendarEvents(events, { timeZone });
  } catch (error) {
    throw new Error(`Google/personal calendar could not be read: ${error.message || error}`);
  }
}

module.exports = {
  isDirectCalendarConfigured,
  getDirectCalendarText,
  parsePersonalIcs,
  eventsForTodayAndTomorrow,
  formatCalendarEvents,
  fetchCalendarIcs,
  calendarFeedUrl
};
