const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGoogleCalendarEvent,
  formatEventSummary,
  normalizeAttendees,
  isGoogleCalendarWriteConfigured
} = require('../google_calendar');

test('buildGoogleCalendarEvent creates a timed event with default 60 minute end', () => {
  const built = buildGoogleCalendarEvent({
    summary: 'Credit consult',
    start: '2026-08-04T09:00:00-07:00',
    timeZone: 'America/Phoenix'
  });
  assert.equal(built.event.summary, 'Credit consult');
  assert.equal(built.event.start.timeZone, 'America/Phoenix');
  assert.equal(built.sendUpdates, 'none');
  assert.equal(
    new Date(built.event.end.dateTime) - new Date(built.event.start.dateTime),
    60 * 60 * 1000
  );
});

test('formatEventSummary reads back an exact human date in the event timezone', () => {
  const built = buildGoogleCalendarEvent({
    summary: 'Lunch with Mike',
    start: '2026-08-04T14:00:00-07:00',
    timeZone: 'America/Phoenix'
  });
  const summary = formatEventSummary({
    event: built.event,
    attendeeEmails: []
  });
  assert.match(summary, /Tuesday, August 4, 2026 at 2:00 PM MST/);
  assert.match(summary, /Tuesday, August 4, 2026 at 3:00 PM MST/);
});

test('buildGoogleCalendarEvent supports all-day events and attendees', () => {
  const built = buildGoogleCalendarEvent({
    summary: 'Offsite',
    start: '2026-08-10',
    attendees: ['Alex@Example.com', 'alex@example.com', 'pat@example.org'],
    location: 'Phoenix'
  });
  assert.deepEqual(built.event.start, { date: '2026-08-10' });
  assert.deepEqual(built.event.end, { date: '2026-08-11' });
  assert.equal(built.event.location, 'Phoenix');
  assert.deepEqual(built.attendeeEmails, ['alex@example.com', 'pat@example.org']);
  assert.equal(built.sendUpdates, 'all');
});

test('buildGoogleCalendarEvent rejects inverted ranges and bad attendees', () => {
  assert.throws(
    () => buildGoogleCalendarEvent({
      summary: 'Bad',
      start: '2026-08-04T10:00:00Z',
      end: '2026-08-04T09:00:00Z'
    }),
    /end must be after start/
  );
  assert.throws(
    () => normalizeAttendees(['not-an-email']),
    /Invalid attendee email/
  );
});

test('isGoogleCalendarWriteConfigured reads dedicated or Gmail fallback env', () => {
  const keys = [
    'GOOGLE_CALENDAR_CLIENT_ID',
    'GOOGLE_CALENDAR_CLIENT_SECRET',
    'GOOGLE_CALENDAR_REFRESH_TOKEN',
    'GMAIL_CLIENT_ID',
    'GMAIL_CLIENT_SECRET',
    'GMAIL_REFRESH_TOKEN'
  ];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(isGoogleCalendarWriteConfigured(), false);

    process.env.GMAIL_CLIENT_ID = 'id';
    process.env.GMAIL_CLIENT_SECRET = 'secret';
    process.env.GMAIL_REFRESH_TOKEN = 'refresh';
    assert.equal(isGoogleCalendarWriteConfigured(), true);

    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'cal-id';
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'cal-secret';
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = 'cal-refresh';
    assert.equal(isGoogleCalendarWriteConfigured(), true);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
