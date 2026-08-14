const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGoogleCalendarEvent,
  buildRescheduledEventTimes,
  cancelGoogleCalendarEvent,
  findMatchingCalendarEvent,
  formatEventSummary,
  normalizeAttendees,
  isGoogleCalendarWriteConfigured,
  listGoogleCalendarEvents,
  rescheduleGoogleCalendarEvent
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

test('listGoogleCalendarEvents requests structured upcoming and cancelled events', async () => {
  const keys = [
    'GOOGLE_CALENDAR_CLIENT_ID',
    'GOOGLE_CALENDAR_CLIENT_SECRET',
    'GOOGLE_CALENDAR_REFRESH_TOKEN',
    'GOOGLE_CALENDAR_ID'
  ];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  const urls = [];
  try {
    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'id';
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = 'refresh';
    process.env.GOOGLE_CALENDAR_ID = 'primary';
    global.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'token' }) };
      }
      return {
        ok: true,
        json: async () => ({
          items: [{
            id: 'event-1',
            status: 'confirmed',
            summary: 'Review',
            start: { dateTime: '2026-08-04T16:00:00Z' },
            end: { dateTime: '2026-08-04T17:00:00Z' },
            attendees: [{ email: 'mike@example.com', displayName: 'Mike', responseStatus: 'accepted' }]
          }, { id: 'deleted-1', status: 'cancelled' }]
        })
      };
    };

    const events = await listGoogleCalendarEvents({
      timeMin: '2026-08-03T00:00:00Z',
      timeMax: '2026-08-10T00:00:00Z'
    });
    assert.equal(events.length, 2);
    assert.equal(events[0].attendees[0].email, 'mike@example.com');
    assert.equal(events[1].status, 'cancelled');
    const listUrl = new URL(urls[1]);
    assert.equal(listUrl.searchParams.get('singleEvents'), 'true');
    assert.equal(listUrl.searchParams.get('showDeleted'), 'true');
    assert.equal(listUrl.searchParams.get('orderBy'), 'startTime');
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('findMatchingCalendarEvent prefers exact titles and refuses ambiguous matches', () => {
  const events = [
    {
      id: 'exact',
      status: 'confirmed',
      summary: 'Pay Gilbert Traffic',
      start: { dateTime: '2026-08-14T17:00:00Z', timeZone: 'America/Phoenix' }
    },
    {
      id: 'longer',
      status: 'confirmed',
      summary: 'Pay Gilbert Traffic follow-up',
      start: { dateTime: '2026-08-15T17:00:00Z', timeZone: 'America/Phoenix' }
    }
  ];
  assert.equal(findMatchingCalendarEvent(events, {
    query: 'pay gilbert traffic'
  }).id, 'exact');

  assert.throws(
    () => findMatchingCalendarEvent([
      events[0],
      { ...events[0], id: 'second', start: { dateTime: '2026-08-21T17:00:00Z' } }
    ], { query: 'Pay Gilbert Traffic' }),
    /More than one calendar event matched/
  );
  assert.throws(
    () => findMatchingCalendarEvent(events, { query: 'Gilbert courthouse filing' }),
    /No upcoming calendar event matched/
  );
});

test('buildRescheduledEventTimes preserves local clock time and duration for a date-only target', () => {
  const times = buildRescheduledEventTimes({
    start: { dateTime: '2026-08-14T17:00:00Z', timeZone: 'America/Phoenix' },
    end: { dateTime: '2026-08-14T18:00:00Z', timeZone: 'America/Phoenix' }
  }, '2026-08-18', { timeZone: 'America/Phoenix' });
  assert.deepEqual(times, {
    start: { dateTime: '2026-08-18T17:00:00.000Z', timeZone: 'America/Phoenix' },
    end: { dateTime: '2026-08-18T18:00:00.000Z', timeZone: 'America/Phoenix' }
  });
});

test('rescheduleGoogleCalendarEvent patches only event times and notifies attendees', async () => {
  const keys = [
    'GOOGLE_CALENDAR_CLIENT_ID',
    'GOOGLE_CALENDAR_CLIENT_SECRET',
    'GOOGLE_CALENDAR_REFRESH_TOKEN',
    'GOOGLE_CALENDAR_ID'
  ];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  const requests = [];
  try {
    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'id';
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = 'refresh';
    process.env.GOOGLE_CALENDAR_ID = 'primary';
    global.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'token' }) };
      }
      if (!options.method) {
        return {
          ok: true,
          json: async () => ({
            items: [{
              id: 'gilbert/event',
              status: 'confirmed',
              summary: 'Pay Gilbert Traffic',
              description: 'Bring citation',
              location: 'Gilbert Municipal Court',
              start: { dateTime: '2026-08-14T17:00:00Z', timeZone: 'America/Phoenix' },
              end: { dateTime: '2026-08-14T18:00:00Z', timeZone: 'America/Phoenix' },
              attendees: [{ email: 'chris@example.com' }],
              htmlLink: 'https://calendar.google.com/event'
            }]
          })
        };
      }
      assert.equal(options.method, 'PATCH');
      return {
        ok: true,
        json: async () => ({
          id: 'gilbert/event',
          status: 'confirmed',
          summary: 'Pay Gilbert Traffic',
          description: 'Bring citation',
          location: 'Gilbert Municipal Court',
          start: { dateTime: '2026-08-18T17:00:00.000Z', timeZone: 'America/Phoenix' },
          end: { dateTime: '2026-08-18T18:00:00.000Z', timeZone: 'America/Phoenix' },
          attendees: [{ email: 'chris@example.com' }],
          htmlLink: 'https://calendar.google.com/event'
        })
      };
    };

    const result = await rescheduleGoogleCalendarEvent({
      event_query: 'Pay Gilbert Traffic',
      new_start: '2026-08-18',
      timeZone: 'America/Phoenix',
      now: new Date('2026-08-14T16:00:00Z')
    });
    assert.equal(result.attendees_notified, true);
    assert.match(result.summary, /Tuesday, August 18, 2026 at 10:00 AM MST/);
    assert.equal(requests.length, 3);
    const patchRequest = requests[2];
    assert.equal(new URL(patchRequest.url).searchParams.get('sendUpdates'), 'all');
    assert.match(patchRequest.url, /gilbert%2Fevent/);
    assert.deepEqual(JSON.parse(patchRequest.options.body), {
      start: { dateTime: '2026-08-18T17:00:00.000Z', timeZone: 'America/Phoenix' },
      end: { dateTime: '2026-08-18T18:00:00.000Z', timeZone: 'America/Phoenix' }
    });
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('cancelGoogleCalendarEvent deletes one exact match and notifies attendees', async () => {
  const keys = [
    'GOOGLE_CALENDAR_CLIENT_ID',
    'GOOGLE_CALENDAR_CLIENT_SECRET',
    'GOOGLE_CALENDAR_REFRESH_TOKEN',
    'GOOGLE_CALENDAR_ID'
  ];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  const requests = [];
  try {
    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'id';
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = 'refresh';
    process.env.GOOGLE_CALENDAR_ID = 'primary';
    global.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'token' }) };
      }
      if (!options.method) {
        return {
          ok: true,
          json: async () => ({
            items: [{
              id: 'cancel-me',
              status: 'confirmed',
              summary: 'Pay Gilbert Traffic',
              start: { dateTime: '2026-08-14T17:00:00Z', timeZone: 'America/Phoenix' },
              end: { dateTime: '2026-08-14T18:00:00Z', timeZone: 'America/Phoenix' },
              attendees: [{ email: 'chris@example.com' }]
            }]
          })
        };
      }
      return { ok: true, status: 204 };
    };

    const result = await cancelGoogleCalendarEvent({
      event_query: 'Pay Gilbert Traffic',
      original_start: '2026-08-14T17:00:00Z',
      timeZone: 'America/Phoenix',
      now: new Date('2026-08-14T16:00:00Z')
    });
    assert.equal(result.title, 'Pay Gilbert Traffic');
    assert.equal(result.attendees_notified, true);
    assert.equal(requests[2].options.method, 'DELETE');
    assert.equal(new URL(requests[2].url).searchParams.get('sendUpdates'), 'all');
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
