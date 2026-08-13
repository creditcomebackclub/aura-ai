const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMorningBrief,
  formatMorningBrief,
  formatCalendarSection,
  formatBlackboardSection,
  findMorningBriefSparkPreference,
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

test('morning brief formats a strange little spark for text and speech', () => {
  const brief = buildMorningBrief({
    goals: [{ title: 'Ship the proposal', created_at: NOW.toISOString() }],
    spark: {
      fact: 'Honey never spoils; sealed jars thousands of years old have remained edible.',
      connection: 'For today, make one useful thing built to last.'
    },
    now: NOW,
    timeZone: TZ
  });

  assert.match(brief.text, /Strange little spark\nHoney never spoils/);
  assert.match(brief.text, /For today, make one useful thing built to last\./);
  assert.match(brief.spoken, /Today's strange little spark\. Honey never spoils/);
});

test('morning brief carries a planned goal next action into text and speech', () => {
  const brief = buildMorningBrief({
    goals: [{
      title: 'Launch the offer',
      created_at: NOW.toISOString(),
      next_action: { action: 'Interview five prospects' }
    }],
    now: NOW,
    timeZone: TZ
  });

  assert.match(brief.text, /Next: Interview five prospects/);
  assert.match(brief.spoken, /Launch the offer; next, Interview five prospects/);
});

test('spark preference is discovered from durable profile entries', () => {
  const value = 'The owner prefers a daily morning brief with a unique “strange little spark”.';
  assert.equal(findMorningBriefSparkPreference({
    entries: {
      unrelated: { value: 'Chris likes concise answers.' },
      spark: { value }
    }
  }), value);
  assert.equal(findMorningBriefSparkPreference({
    entries: { unrelated: { value: 'Chris likes unusual facts.' } }
  }), null);
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

test('morning brief runner generates a spark only when the durable preference exists', async () => {
  const alerts = [];
  let generationInput = null;
  const result = await runMorningBrief({
    listOpenGoals: async () => [{ title: 'Finish the brief', created_at: NOW.toISOString() }],
    getCalendarText: async () => 'No events scheduled today.',
    getBlackboardUpcoming: async () => [],
    getOwnerProfile: async () => ({
      entries: {
        spark: {
          value: 'The owner prefers a daily morning brief with a unique strange little spark.'
        }
      }
    }),
    generateSpark: async input => {
      generationInput = input;
      return {
        fact: 'A group of flamingos is called a flamboyance.',
        connection: 'Bring a little more color to the one task that matters most.'
      };
    },
    sendAlert: async (text, category, urgency, options) => {
      alerts.push({ text, category, urgency, options });
      return { id: 2, deduplicated: false };
    },
    timeZone: TZ,
    now: NOW,
    ownerName: 'Chris'
  });

  assert.equal(result.spark, true);
  assert.equal(generationInput.goals[0].title, 'Finish the brief');
  assert.match(alerts[0].text, /Strange little spark/);
  assert.match(alerts[0].options.spoken, /Today's strange little spark/);
  assert.deepEqual(alerts[0].options.metadata.morning_spark, {
    fact: 'A group of flamingos is called a flamboyance.',
    connection: 'Bring a little more color to the one task that matters most.'
  });
});

test('morning brief still sends its useful sections if spark generation fails', async () => {
  const alerts = [];
  const result = await runMorningBrief({
    listOpenGoals: async () => [{ title: 'Keep moving', created_at: NOW.toISOString() }],
    getOwnerProfile: async () => ({
      entries: {
        spark: { value: 'Include a strange little spark in the morning brief.' }
      }
    }),
    generateSpark: async () => {
      throw new Error('temporary model outage');
    },
    sendAlert: async text => {
      alerts.push(text);
      return { id: 3, deduplicated: false };
    },
    timeZone: TZ,
    now: NOW
  });

  assert.equal(result.status, 'sent');
  assert.equal(result.spark, false);
  assert.deepEqual(result.errors, ['spark:temporary model outage']);
  assert.match(alerts[0], /Goals \(1\)/);
  assert.doesNotMatch(alerts[0], /Strange little spark/);
});

test('morning brief runner honors trusted durable section preferences', async () => {
  let goalsRead = false;
  let calendarRead = false;
  let blackboardOptions = null;
  const alerts = [];
  const result = await runMorningBrief({
    listOpenGoals: async () => {
      goalsRead = true;
      return [{ title: 'Should not appear', created_at: NOW.toISOString() }];
    },
    getCalendarText: async () => {
      calendarRead = true;
      return 'Event: Keep this';
    },
    getBlackboardUpcoming: async options => {
      blackboardOptions = options;
      return [{ title: 'Due soon', due_at: '2026-08-06T18:00:00Z' }];
    },
    getOwnerProfile: async () => ({
      entries: {
        format: { kind: 'preference', value: 'Only include calendar and Blackboard from the next 6 days in my morning brief.' }
      }
    }),
    sendAlert: async text => {
      alerts.push(text);
      return { deduplicated: false };
    },
    timeZone: TZ,
    now: NOW
  });

  assert.equal(result.status, 'sent');
  assert.equal(goalsRead, false);
  assert.equal(calendarRead, true);
  assert.deepEqual(blackboardOptions, { withinDays: 6 });
  assert.doesNotMatch(alerts[0], /Goals/);
  assert.match(alerts[0], /Calendar/);
  assert.match(alerts[0], /Blackboard/);
});
