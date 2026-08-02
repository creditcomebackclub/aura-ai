const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMorningBrief,
  formatMorningBrief,
  formatCalendarSection,
  formatBlackboardSection,
  filterUpcomingAssignments,
  runMorningBrief
} = require('../morning_brief');

const TZ = 'America/Phoenix';
const NOW = new Date('2026-08-05T14:30:00Z');

test('morning brief stays quiet when nothing is open', () => {
  assert.equal(formatMorningBrief({ goals: [], calendarText: null, blackboardUpcoming: [] }), null);
  assert.equal(buildMorningBrief({ goals: [], calendarText: null, blackboardUpcoming: [] }), null);
});

test('morning brief uses readable multi-line sections and greets Chris', () => {
  const brief = buildMorningBrief({
    goals: [
      { description: 'Call the court', due_at: '2026-08-06T00:00:00.000Z', created_at: NOW.toISOString() },
      { title: 'Ship letters', created_at: NOW.toISOString() }
    ],
    calendarText: 'Event: Dentist at 2pm\nEvent: Standup at 4pm',
    blackboardUpcoming: [
      // 06:59Z = 11:59pm Phoenix on Aug 5 — date header only, no repeated time.
      { title: 'Week 5 Discussion [due Day 3]', due_at: '2026-08-06T06:59:00Z' }
    ],
    now: NOW,
    timeZone: TZ,
    ownerName: 'Chris'
  });

  assert.equal(brief.text, [
    'Good morning, Chris.',
    '',
    'Goals (2)',
    '1. Call the court — due today',
    '2. Ship letters',
    '',
    'Calendar',
    '• Dentist at 2pm',
    '• Standup at 4pm',
    '',
    'Blackboard (1)',
    'Wed, Aug 5',
    '• Week 5 Discussion',
    '',
    'Ask me anytime if you want to knock something out.'
  ].join('\n'));

  assert.match(brief.spoken, /^Good morning, Chris\./);
  assert.match(brief.spoken, /On your list, 2 things: Call the court, due today; Ship letters\./);
  assert.match(brief.spoken, /On the calendar: Dentist at 2pm; Standup at 4pm\./);
  assert.match(brief.spoken, /Blackboard has 1 deadline on Wed, Aug 5: Week 5 Discussion\./);
  assert.doesNotMatch(brief.spoken, /•/);
});

test('calendar section cleans Event/Starts noise and clear days', () => {
  assert.equal(formatCalendarSection('No events scheduled today.'), 'Calendar\nClear.');
  assert.equal(
    formatCalendarSection(
      'Event: David Moya and Chris Holland @ +1 786-333-7550 (Starts: Mon, Aug 3, 9:00 AM)'
    ),
    [
      'Calendar',
      '• David Moya and Chris Holland @ +1 786-333-7550 — Mon, Aug 3, 9:00 AM'
    ].join('\n')
  );
});

test('blackboard section groups by day and drops 11:59pm noise', () => {
  const text = formatBlackboardSection([
    { title: 'Wk 5 - Labs [due Day 3]', due_at: '2026-08-06T06:59:00Z' },
    { title: 'Wk 5 - Pre-Assessment', due_at: '2026-08-06T06:59:00Z' },
    { title: 'Live quiz', due_at: '2026-08-06T18:00:00Z' }
  ], { timeZone: TZ });

  assert.equal(text, [
    'Blackboard (3)',
    'Wed, Aug 5',
    '• Wk 5 - Labs',
    '• Wk 5 - Pre-Assessment',
    'Thu, Aug 6',
    '• Live quiz — 11:00 AM'
  ].join('\n'));
});

test('filterUpcomingAssignments keeps only the next N days', () => {
  const items = filterUpcomingAssignments([
    { title: 'Soon', due_at: '2026-08-06T12:00:00Z' },
    { title: 'Later', due_at: '2026-08-20T12:00:00Z' },
    { title: 'Past', due_at: '2026-08-01T12:00:00Z' }
  ], { now: NOW, withinDays: 3 });
  assert.deepEqual(items.map(item => item.title), ['Soon']);
});

test('morning brief runner sends spoken + telegramVoice options', async () => {
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
    now: NOW,
    ownerName: 'Chris'
  });
  assert.equal(first.status, 'sent');
  assert.equal(alerts[0].category, 'morning_brief');
  assert.match(alerts[0].options.dedupeKey, /^morning-brief:/);
  assert.match(alerts[0].text, /^Good morning, Chris\./);
  assert.match(alerts[0].text, /Calendar\nClear\./);
  assert.equal(alerts[0].options.telegramVoice, true);
  assert.match(alerts[0].options.spoken, /^Good morning, Chris\./);
  assert.match(alerts[0].options.spoken, /Your calendar is clear\./);

  const second = await runMorningBrief({
    listOpenGoals: async () => goals,
    sendAlert: async () => ({ deduplicated: true }),
    timeZone: TZ,
    now: NOW
  });
  assert.equal(second.status, 'deduplicated');
  assert.equal(alerts.length, 1);
});
