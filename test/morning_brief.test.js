const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatMorningBrief,
  formatCalendarSection,
  filterUpcomingAssignments,
  runMorningBrief
} = require('../morning_brief');

const TZ = 'America/Phoenix';
const NOW = new Date('2026-08-05T14:30:00Z');

test('morning brief stays quiet when nothing is open', () => {
  assert.equal(formatMorningBrief({ goals: [], calendarText: null, blackboardUpcoming: [] }), null);
});

test('morning brief combines goals, calendar, and Blackboard', () => {
  const text = formatMorningBrief({
    goals: [
      { description: 'Call the court', due_at: '2026-08-06T00:00:00.000Z', created_at: NOW.toISOString() },
      { title: 'Ship letters', created_at: NOW.toISOString() }
    ],
    calendarText: 'Event: Dentist at 2pm\nEvent: Standup at 4pm',
    blackboardUpcoming: [
      { title: 'Week 5 Discussion', due_at: '2026-08-06T06:59:00Z' }
    ],
    now: NOW,
    timeZone: TZ
  });
  assert.match(text, /^Morning\./);
  assert.match(text, /On your list \(2\)/);
  assert.match(text, /Call the court, due today/);
  assert.match(text, /Today on the calendar: Dentist at 2pm; Standup at 4pm/);
  assert.match(text, /Blackboard: 1 deadline/);
  assert.match(text, /Week 5 Discussion/);
});

test('calendar section compresses clear days and event lines', () => {
  assert.equal(formatCalendarSection('No events scheduled today.'), 'Calendar is clear today.');
  assert.match(formatCalendarSection('Event: A\nEvent: B'), /Today on the calendar: A; B/);
});

test('filterUpcomingAssignments keeps only the next N days', () => {
  const items = filterUpcomingAssignments([
    { title: 'Soon', due_at: '2026-08-06T12:00:00Z' },
    { title: 'Later', due_at: '2026-08-20T12:00:00Z' },
    { title: 'Past', due_at: '2026-08-01T12:00:00Z' }
  ], { now: NOW, withinDays: 3 });
  assert.deepEqual(items.map(item => item.title), ['Soon']);
});

test('morning brief runner sends once and dedupes by Phoenix day', async () => {
  const alerts = [];
  const goals = [{ title: 'Pay rent', created_at: NOW.toISOString() }];

  const first = await runMorningBrief({
    listOpenGoals: async () => goals,
    getCalendarText: async () => 'No events scheduled today.',
    getBlackboardUpcoming: async () => [],
    sendAlert: async (text, category, urgency, options) => {
      alerts.push({ text, category, urgency, options });
      return { id: 1, deduplicated: false };
    },
    timeZone: TZ,
    now: NOW
  });
  assert.equal(first.status, 'sent');
  assert.equal(alerts[0].category, 'morning_brief');
  assert.match(alerts[0].options.dedupeKey, /^morning-brief:/);
  assert.match(alerts[0].text, /Pay rent/);
  assert.match(alerts[0].text, /Calendar is clear today/);

  const second = await runMorningBrief({
    listOpenGoals: async () => goals,
    sendAlert: async () => ({ deduplicated: true }),
    timeZone: TZ,
    now: NOW
  });
  assert.equal(second.status, 'deduplicated');
  assert.equal(alerts.length, 1);
});
