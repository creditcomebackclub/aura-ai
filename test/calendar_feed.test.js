const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePersonalIcs,
  eventsForTodayAndTomorrow,
  formatCalendarEvents,
  getDirectCalendarText,
  isDirectCalendarConfigured
} = require('../calendar_feed');

const TZ = 'America/Phoenix';
// Wednesday 2026-08-05 mid-morning Phoenix.
const NOW = new Date('2026-08-05T17:00:00Z');

const SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:consult-1@example.com',
  'DTSTART;TZID=America/Phoenix:20260805T140000',
  'DTEND;TZID=America/Phoenix:20260805T143000',
  'SUMMARY:Credit consult - Jane Doe',
  'LOCATION:Zoom',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:consult-2@example.com',
  'DTSTART;TZID=America/Phoenix:20260806T100000',
  'SUMMARY:Credit consult - Tomorrow',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:old@example.com',
  'DTSTART;TZID=America/Phoenix:20260801T100000',
  'SUMMARY:Last week',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:cancelled@example.com',
  'DTSTART;TZID=America/Phoenix:20260805T160000',
  'SUMMARY:Cancelled consult',
  'STATUS:CANCELLED',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

test('isDirectCalendarConfigured reads CALENDAR_ICAL_URL', () => {
  const previous = process.env.CALENDAR_ICAL_URL;
  delete process.env.CALENDAR_ICAL_URL;
  delete process.env.GOOGLE_CALENDAR_ICAL_URL;
  assert.equal(isDirectCalendarConfigured(), false);
  process.env.CALENDAR_ICAL_URL = 'https://calendar.google.com/calendar/ical/secret/basic.ics';
  assert.equal(isDirectCalendarConfigured(), true);
  if (previous === undefined) delete process.env.CALENDAR_ICAL_URL;
  else process.env.CALENDAR_ICAL_URL = previous;
});

test('parsePersonalIcs extracts timed events and skips cancelled', () => {
  const events = parsePersonalIcs(SAMPLE_ICS, { timeZone: TZ });
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(event => event.title).sort(), [
    'Credit consult - Jane Doe',
    'Credit consult - Tomorrow',
    'Last week'
  ].sort());
  const consult = events.find(event => event.title.includes('Jane Doe'));
  assert.equal(consult.location, 'Zoom');
  assert.equal(consult.all_day, false);
});

test('eventsForTodayAndTomorrow keeps only the local two-day window', () => {
  const events = eventsForTodayAndTomorrow(
    parsePersonalIcs(SAMPLE_ICS, { timeZone: TZ }),
    { now: NOW, timeZone: TZ }
  );
  assert.deepEqual(events.map(event => event.title), [
    'Credit consult - Jane Doe',
    'Credit consult - Tomorrow'
  ]);
});

test('formatCalendarEvents matches the Event: line shape morning brief expects', () => {
  const events = eventsForTodayAndTomorrow(
    parsePersonalIcs(SAMPLE_ICS, { timeZone: TZ }),
    { now: NOW, timeZone: TZ }
  );
  const text = formatCalendarEvents(events, { timeZone: TZ });
  assert.match(text, /^Event: Credit consult - Jane Doe @ Zoom \(Starts:/);
  assert.match(text, /Event: Credit consult - Tomorrow \(Starts:/);
});

test('getDirectCalendarText fetches ICS and formats today/tomorrow', async () => {
  const previous = process.env.CALENDAR_ICAL_URL;
  process.env.CALENDAR_ICAL_URL = 'https://example.com/private.ics';
  try {
    const text = await getDirectCalendarText({
      now: NOW,
      timeZone: TZ,
      fetchImpl: async () => ({
        ok: true,
        text: async () => SAMPLE_ICS
      })
    });
    assert.match(text, /Credit consult - Jane Doe/);
    assert.match(text, /Credit consult - Tomorrow/);
    assert.doesNotMatch(text, /Last week|Cancelled consult/);
  } finally {
    if (previous === undefined) delete process.env.CALENDAR_ICAL_URL;
    else process.env.CALENDAR_ICAL_URL = previous;
  }
});

test('getDirectCalendarText rejects non-ICS payloads', async () => {
  const previous = process.env.CALENDAR_ICAL_URL;
  process.env.CALENDAR_ICAL_URL = 'https://example.com/private.ics';
  try {
    await assert.rejects(
      () => getDirectCalendarText({
        fetchImpl: async () => ({
          ok: true,
          text: async () => '<html>login</html>'
        })
      }),
      /did not return iCalendar data/i
    );
  } finally {
    if (previous === undefined) delete process.env.CALENDAR_ICAL_URL;
    else process.env.CALENDAR_ICAL_URL = previous;
  }
});
