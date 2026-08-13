'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXECUTIVE_LOOP_STATE_KEY,
  calendarSignal,
  classifyEmail,
  extractOwnerCommitment,
  formatGoalSignalAlert,
  isQuietTime,
  buildMeetingBrief,
  createExecutiveLoop
} = require('../executive_loop');

const TZ = 'America/Phoenix';

test('email triage surfaces action and urgency while ignoring newsletter noise', () => {
  assert.deepEqual(
    classifyEmail({ from: 'Mike <mike@example.com>', subject: 'Can you review this?', snippet: 'Let me know.' }),
    { category: 'action', actionable: true, urgency: 'normal', reason: 'This appears to need a response or decision.' }
  );
  assert.equal(
    classifyEmail({ from: 'Security <no-reply@example.com>', subject: 'Urgent security alert' }).urgency,
    'high'
  );
  assert.equal(
    classifyEmail({ from: 'Newsletter <no-reply@example.com>', subject: 'Weekly digest', snippet: 'Unsubscribe' }).actionable,
    false
  );
});

test('sent email commitments require both an owner promise and a concrete deadline', () => {
  const commitment = extractOwnerCommitment({
    id: 'sent-123',
    to: 'Mike <mike@example.com>',
    subject: 'Re: documents',
    snippet: "I'll send the updated packet by Friday. Thanks."
  }, {
    now: new Date('2026-08-03T16:00:00Z'),
    timeZone: TZ
  });

  assert.equal(commitment.title, 'Follow through: send the updated packet');
  assert.equal(commitment.due_at, '2026-08-08T00:00:00.000Z');
  assert.equal(commitment.recipient, 'Mike <mike@example.com>');
  assert.match(commitment.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(extractOwnerCommitment({
    id: 'sent-124',
    snippet: "I'll send the updated packet soon."
  }, { now: new Date('2026-08-03T16:00:00Z'), timeZone: TZ }), null);
  assert.equal(extractOwnerCommitment({
    id: 'incoming-1',
    snippet: 'Please send the packet by Friday.'
  }, { now: new Date('2026-08-03T16:00:00Z'), timeZone: TZ }), null);
  assert.equal(extractOwnerCommitment({
    id: 'quoted-1',
    snippet: "Sounds good. On Monday, Mike wrote: I'll send the packet by Friday."
  }, { now: new Date('2026-08-03T16:00:00Z'), timeZone: TZ }), null);
  assert.equal(extractOwnerCommitment({
    id: 'subject-only-1',
    subject: "I'll send the packet by Friday",
    snippet: 'Sounds good.'
  }, { now: new Date('2026-08-03T16:00:00Z'), timeZone: TZ }), null);
});

test('quiet hours cross midnight in the configured timezone', () => {
  assert.equal(isQuietTime(new Date('2026-08-04T05:00:00Z'), {
    timeZone: TZ,
    quietStartHour: 21,
    quietEndHour: 7
  }), true); // 10pm Phoenix
  assert.equal(isQuietTime(new Date('2026-08-04T15:00:00Z'), {
    timeZone: TZ,
    quietStartHour: 21,
    quietEndHour: 7
  }), false); // 8am Phoenix
});

test('meeting briefs include attendees and matching unread email context', () => {
  const brief = buildMeetingBrief({
    id: 'meeting-1',
    summary: 'Review with Mike',
    start: { dateTime: '2026-08-03T16:15:00Z' },
    location: 'Zoom',
    attendees: [{ email: 'mike@example.com', displayName: 'Mike' }]
  }, [
    { from: 'Mike <mike@example.com>', subject: 'Numbers for our review' },
    { from: 'Someone Else <other@example.com>', subject: 'Unrelated' }
  ], {
    now: new Date('2026-08-03T16:00:00Z'),
    timeZone: TZ,
    tasks: [{ id: 'task-mike', title: 'Send Mike the updated packet' }],
    clientSnapshots: [{
      found: true,
      client: { name: 'Mike Example', status: 'Active', billing_status: 'Current' },
      current_phase: 'Phase 2',
      outstanding_total: 125
    }]
  });

  assert.match(brief, /starts in 15 minutes/);
  assert.match(brief, /Location: Zoom/);
  assert.match(brief, /With: Mike/);
  assert.match(brief, /Unread context: Mike — “Numbers for our review”/);
  assert.match(brief, /CCC: Mike Example — Phase 2 · Active · Current · \$125\.00 outstanding/);
  assert.match(brief, /Open follow-up: Send Mike the updated packet/);
  assert.doesNotMatch(brief, /Unrelated/);
});

function createHarness({
  now = new Date('2026-08-03T16:00:00Z'),
  getPreferences,
  matchGoalSignals,
  recordGoalMatch
} = {}) {
  let currentTime = now;
  let state = null;
  let emails = [];
  let sentEmails = [];
  let events = [];
  let tasks = [];
  const alerts = [];
  const dedupe = new Set();
  const commitments = [];
  const run = createExecutiveLoop({
    listUnreadEmails: async () => emails,
    listSentEmails: async () => sentEmails,
    getEmailIdentity: async () => 'creditcomebackclub@gmail.com',
    getPreferences,
    matchGoalSignals,
    recordGoalMatch,
    listCalendarEvents: async () => events,
    listOpenTasks: async () => tasks,
    getState: async key => key === EXECUTIVE_LOOP_STATE_KEY ? state : null,
    setState: async (key, value) => {
      assert.equal(key, EXECUTIVE_LOOP_STATE_KEY);
      state = structuredClone(value);
    },
    createCommitment: async commitment => {
      commitments.push(structuredClone(commitment));
      return { id: commitment.id };
    },
    sendAlert: async (text, category, urgency, options) => {
      const duplicate = dedupe.has(options.dedupeKey);
      dedupe.add(options.dedupeKey);
      alerts.push({ text, category, urgency, options, duplicate });
      return { id: alerts.length, deduplicated: duplicate };
    },
    timeZone: TZ,
    now: () => new Date(currentTime)
  });
  return {
    run,
    alerts,
    commitments,
    getState: () => state,
    setNow: value => { currentTime = new Date(value); },
    setEmails: value => { emails = value; },
    setSentEmails: value => { sentEmails = value; },
    setEvents: value => { events = value; },
    setTasks: value => { tasks = value; }
  };
}

test('durable preferences can move the active quiet-hours window', async () => {
  const harness = createHarness({
    now: new Date('2026-08-03T16:00:00Z'), // 9am Phoenix
    getPreferences: async () => ({ quietStartHour: 8, quietEndHour: 10 })
  });
  await harness.run();
  harness.setNow('2026-08-03T16:05:00Z');
  harness.setEmails([{
    id: 'routine-during-custom-quiet',
    from: 'Mike <mike@example.com>',
    subject: 'Can you review this?',
    snippet: 'Please take a look.'
  }]);
  const result = await harness.run();
  assert.equal(result.sent, 0);
});

test('first run baselines old data, then alerts once for new executive events', async () => {
  const harness = createHarness();
  harness.setEmails([{ id: 'old-mail', from: 'Mike <mike@example.com>', subject: 'Can you reply?' }]);
  harness.setEvents([{
    id: 'future-event',
    status: 'confirmed',
    summary: 'Future review',
    start: { dateTime: '2026-08-04T18:00:00Z' },
    end: { dateTime: '2026-08-04T19:00:00Z' },
    attendees: []
  }]);

  const initial = await harness.run();
  assert.equal(initial.status, 'initialized');
  assert.equal(initial.sent, 0);
  assert.deepEqual(harness.getState().known_email_ids, ['old-mail']);

  harness.setNow('2026-08-03T16:05:00Z');
  harness.setEmails([
    { id: 'new-mail', from: 'Mike <mike@example.com>', subject: 'Can you approve this?', snippet: 'Please let me know.' },
    { id: 'old-mail', from: 'Mike <mike@example.com>', subject: 'Can you reply?' }
  ]);
  harness.setEvents([
    {
      id: 'future-event',
      status: 'confirmed',
      summary: 'Future review',
      start: { dateTime: '2026-08-04T19:00:00Z' },
      end: { dateTime: '2026-08-04T20:00:00Z' },
      attendees: [],
      updated: '2026-08-03T16:04:00Z'
    },
    {
      id: 'meeting-soon',
      status: 'confirmed',
      summary: 'Mike review',
      start: { dateTime: '2026-08-03T16:20:00Z' },
      end: { dateTime: '2026-08-03T17:00:00Z' },
      attendees: [{ email: 'mike@example.com', displayName: 'Mike' }]
    }
  ]);
  harness.setTasks([{
    id: 'task-1',
    title: 'Send the packet',
    due_at: '2026-08-03T16:35:00Z'
  }]);

  const checked = await harness.run();
  assert.equal(checked.status, 'checked');
  assert.deepEqual(new Set(checked.categories), new Set(['email', 'calendar', 'meeting', 'commitment']));
  assert.match(harness.alerts.find(item => item.category === 'meeting_brief').text, /Unread context: Mike/);

  const repeated = await harness.run();
  assert.equal(repeated.sent, 0);
});

test('sent promises are baselined, then captured once as durable commitments', async () => {
  const harness = createHarness();
  harness.setSentEmails([{
    id: 'old-sent',
    to: 'Mike <mike@example.com>',
    snippet: "I'll send this by Friday."
  }]);
  await harness.run();
  assert.equal(harness.commitments.length, 0);

  harness.setSentEmails([{
    id: 'new-sent',
    thread_id: 'thread-1',
    to: 'Mike <mike@example.com>',
    subject: 'Re: packet',
    snippet: "I'll send the corrected packet tomorrow."
  }, {
    id: 'old-sent',
    to: 'Mike <mike@example.com>',
    snippet: "I'll send this by Friday."
  }]);
  const result = await harness.run();
  assert.deepEqual(result.categories, ['captured']);
  assert.equal(harness.commitments.length, 1);
  assert.equal(harness.commitments[0].title, 'Follow through: send the corrected packet');
  assert.equal(harness.commitments[0].source_thread_id, 'thread-1');
  assert.equal(harness.alerts.at(-1).category, 'commitment_captured');

  const repeated = await harness.run();
  assert.equal(repeated.sent, 0);
  assert.equal(harness.commitments.length, 1);
});

test('quiet hours defer routine email but still surface urgent mail', async () => {
  const harness = createHarness({ now: new Date('2026-08-04T04:00:00Z') }); // 9pm Phoenix
  await harness.run();

  harness.setEmails([
    { id: 'routine', from: 'Mike <mike@example.com>', subject: 'Can you review this?' },
    { id: 'urgent', from: 'Bank <no-reply@bank.example>', subject: 'Urgent: payment failed' }
  ]);
  const quietRun = await harness.run();
  assert.deepEqual(quietRun.categories, ['email']);
  assert.match(harness.alerts[0].text, /payment failed/i);
  assert.deepEqual(harness.getState().known_email_ids, ['urgent']);

  harness.setNow('2026-08-04T14:05:00Z'); // 7:05am Phoenix
  const morningRun = await harness.run();
  assert.deepEqual(morningRun.categories, ['email']);
  assert.match(harness.alerts[1].text, /review this/i);
});

test('concurrent scheduler triggers share one active run', async () => {
  let releases;
  let calls = 0;
  const wait = new Promise(resolve => { releases = resolve; });
  const run = createExecutiveLoop({
    listUnreadEmails: async () => { calls += 1; await wait; return []; },
    listCalendarEvents: async () => [],
    listOpenTasks: async () => [],
    getState: async () => null,
    setState: async () => {},
    sendAlert: async () => ({ deduplicated: false })
  });
  const first = run();
  const second = run();
  releases();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('a provider outage cannot make old email look new after recovery', async () => {
  let state = null;
  let fail = true;
  const alerts = [];
  const run = createExecutiveLoop({
    listUnreadEmails: async () => {
      if (fail) throw new Error('temporary OAuth outage');
      return [{ id: 'already-there', from: 'Mike <mike@example.com>', subject: 'Can you reply?' }];
    },
    listCalendarEvents: async () => [],
    listOpenTasks: async () => [],
    getState: async () => state,
    setState: async (_key, value) => { state = structuredClone(value); },
    sendAlert: async text => { alerts.push(text); return { deduplicated: false }; },
    now: () => new Date('2026-08-03T16:00:00Z')
  });

  const failed = await run();
  assert.equal(failed.status, 'initialized');
  assert.equal(state.email_initialized_at, null);
  assert.match(failed.errors[0], /^email:/);

  fail = false;
  const recovered = await run();
  assert.equal(recovered.sent, 0);
  assert.ok(state.email_initialized_at);
  assert.deepEqual(state.known_email_ids, ['already-there']);
  assert.deepEqual(alerts, []);
});

// --- Goal connections -------------------------------------------------------

const PARTNERSHIP_MATCH = {
  goal_id: 'goal-1',
  goal_text: 'setup partnership with identity iq',
  confidence: 0.88,
  tier: 'deterministic',
  matched_by: ['domain'],
  evidence: [{ canonical: 'identityiq', signal_type: 'domain', signal_source: 'sender_domain', weight: 0.88 }],
  scores: { deterministic: 0.88 }
};

const IDENTITY_IQ_WINDOWS = [
  { start: '2026-08-06T22:00:00Z', end: '2026-08-07T00:00:00Z', minutes: 120, label: 'Thursday, Aug 6 3–5 PM' }
];

function goalSignalHarness({
  matches = [PARTNERSHIP_MATCH],
  windows = IDENTITY_IQ_WINDOWS,
  links = {},
  fail = false
} = {}) {
  const seen = [];
  const recorded = [];
  const harness = createHarness({
    matchGoalSignals: async ({ signal, source, events }) => {
      seen.push({ id: signal.id, source, subject: signal.subject, eventCount: events.length });
      if (fail) throw new Error('index unavailable');
      return { matches, windows, links };
    },
    recordGoalMatch: async entry => { recorded.push(entry); }
  });
  return { ...harness, seen, recorded };
}

test('the assistant connects an inbound email to an open goal and offers free time', async () => {
  const harness = goalSignalHarness();
  await harness.run();

  harness.setNow('2026-08-03T16:05:00Z');
  harness.setEmails([{
    id: 'email-iq-1',
    from: '"Matt Rivera" <matt@identityiq.com>',
    subject: 'Reseller partnership — next steps',
    snippet: 'Wanted to see if you had time this week to talk through the agreement.'
  }]);
  await harness.run();

  const alert = harness.alerts.find(item => item.category === 'goal_signal');
  assert.ok(alert, 'expected a goal_signal alert');
  assert.match(alert.text, /Matt Rivera emailed you/);
  assert.match(alert.text, /lines up with your goal: setup partnership with identity iq/);
  assert.match(alert.text, /You're open Thursday, Aug 6 3–5 PM if you want to set up a time/);
  assert.equal(alert.options.metadata.goal_id, 'goal-1');
  assert.equal(alert.options.metadata.tier, 'deterministic');

  assert.equal(harness.recorded.length, 1);
  assert.equal(harness.recorded[0].match.goal_id, 'goal-1');
  assert.equal(harness.recorded[0].source, 'email');
  assert.ok(harness.recorded[0].notificationId != null, 'the ledger should capture the notification id');
});

test('a goal connection fires even when the email is not otherwise actionable', async () => {
  const harness = goalSignalHarness();
  await harness.run();

  harness.setNow('2026-08-03T16:05:00Z');
  harness.setEmails([{
    id: 'email-iq-2',
    from: '"Matt Rivera" <matt@identityiq.com>',
    subject: 'Great meeting you at the conference',
    snippet: 'Just wanted to say it was good connecting.'
  }]);
  await harness.run();

  assert.equal(harness.alerts.filter(item => item.category === 'executive_email').length, 0);
  assert.equal(harness.alerts.filter(item => item.category === 'goal_signal').length, 1);
  assert.deepEqual(harness.seen.map(item => item.id), ['email-iq-2']);
});

test('automated mail never reaches the goal matcher', async () => {
  const harness = goalSignalHarness();
  await harness.run();

  harness.setNow('2026-08-03T16:05:00Z');
  harness.setEmails([{
    id: 'newsletter-1',
    from: 'Digest <no-reply@identityiq.com>',
    subject: 'Weekly digest',
    snippet: 'Unsubscribe at any time.'
  }]);
  await harness.run();

  assert.deepEqual(harness.seen, []);
  assert.equal(harness.alerts.filter(item => item.category === 'goal_signal').length, 0);
});

test('quiet hours hold goal connections without losing them', async () => {
  const harness = goalSignalHarness();
  await harness.run();

  harness.setNow('2026-08-04T06:00:00Z'); // 11pm Phoenix
  harness.setEmails([{
    id: 'email-iq-3',
    from: '"Matt Rivera" <matt@identityiq.com>',
    subject: 'Partnership paperwork',
    snippet: 'Can you review the draft?'
  }]);
  await harness.run();
  assert.equal(harness.alerts.filter(item => item.category === 'goal_signal').length, 0);
  assert.deepEqual(harness.seen, []);

  harness.setNow('2026-08-04T16:00:00Z'); // 9am Phoenix
  await harness.run();
  assert.equal(harness.alerts.filter(item => item.category === 'goal_signal').length, 1);
  assert.deepEqual(harness.seen.map(item => item.id), ['email-iq-3']);
});

test('a quiet-hours connection survives even when the email is not actionable', async () => {
  const harness = goalSignalHarness();
  await harness.run();

  // Non-actionable mail is marked seen by the email tracker on arrival, so goal
  // matching must not depend on that tracker to find it again after quiet hours.
  harness.setNow('2026-08-04T06:00:00Z'); // 11pm Phoenix
  harness.setEmails([{
    id: 'email-iq-quiet',
    from: '"Matt Rivera" <matt@identityiq.com>',
    subject: 'Great meeting you at the conference',
    snippet: 'Just wanted to say it was good connecting.'
  }]);
  await harness.run();
  assert.deepEqual(harness.seen, []);

  harness.setNow('2026-08-04T16:00:00Z'); // 9am Phoenix
  await harness.run();
  assert.deepEqual(harness.seen.map(item => item.id), ['email-iq-quiet']);
  assert.equal(harness.alerts.filter(item => item.category === 'goal_signal').length, 1);
});

test('a matcher outage retries the signal on the next run', async () => {
  const failing = goalSignalHarness({ fail: true });
  await failing.run();
  failing.setNow('2026-08-03T16:05:00Z');
  failing.setEmails([{
    id: 'email-iq-4',
    from: '"Matt Rivera" <matt@identityiq.com>',
    subject: 'Partnership',
    snippet: 'Following up.'
  }]);
  const result = await failing.run();

  assert.match(result.errors.find(item => item.startsWith('goal_signal:')), /index unavailable/);
  assert.deepEqual(failing.getState().goal_signaled_ids, [], 'a failed signal must not be marked as seen');
});

test('a new calendar invitation is matched like any other signal', async () => {
  const harness = goalSignalHarness();
  await harness.run();

  harness.setNow('2026-08-03T16:05:00Z');
  harness.setEvents([{
    id: 'event-iq-1',
    status: 'confirmed',
    summary: 'Intro call',
    start: { dateTime: '2026-08-06T22:00:00Z' },
    end: { dateTime: '2026-08-06T23:00:00Z' },
    attendees: [{ email: 'matt@identityiq.com', displayName: 'Matt Rivera' }]
  }]);
  await harness.run();

  const alert = harness.alerts.find(item => item.category === 'goal_signal');
  assert.ok(alert);
  assert.match(alert.text, /Intro call puts you with Matt Rivera/);
  assert.equal(harness.seen[0].source, 'calendar');
  assert.equal(harness.recorded[0].source, 'calendar');
});

test('the baseline run never fires goal connections for pre-existing mail', async () => {
  const harness = goalSignalHarness();
  harness.setEmails([{
    id: 'old-email',
    from: '"Matt Rivera" <matt@identityiq.com>',
    subject: 'Partnership',
    snippet: 'Following up.'
  }]);
  harness.setEvents([{
    id: 'old-event',
    status: 'confirmed',
    summary: 'Intro call',
    start: { dateTime: '2026-08-06T22:00:00Z' },
    end: { dateTime: '2026-08-06T23:00:00Z' },
    attendees: [{ email: 'matt@identityiq.com', displayName: 'Matt Rivera' }]
  }]);
  await harness.run();

  assert.deepEqual(harness.seen, []);
  assert.equal(harness.alerts.filter(item => item.category === 'goal_signal').length, 0);
});

test('the same signal is only ever announced once', async () => {
  const harness = goalSignalHarness();
  await harness.run();
  harness.setNow('2026-08-03T16:05:00Z');
  harness.setEmails([{
    id: 'email-iq-5',
    from: '"Matt Rivera" <matt@identityiq.com>',
    subject: 'Partnership',
    snippet: 'Following up.'
  }]);
  await harness.run();
  await harness.run();

  assert.equal(harness.seen.length, 1);
  assert.equal(harness.alerts.filter(item => item.category === 'goal_signal' && !item.duplicate).length, 1);
});

test('goal alerts read naturally with and without free time', () => {
  const withTime = formatGoalSignalAlert({
    match: PARTNERSHIP_MATCH,
    signal: { from: '"Matt Rivera" <matt@identityiq.com>', subject: 'Reseller partnership' },
    windows: IDENTITY_IQ_WINDOWS
  });
  assert.equal(
    withTime,
    'Goal connection\n' +
    'Matt Rivera emailed you — “Reseller partnership”.\n' +
    'This lines up with your goal: setup partnership with identity iq.\n' +
    "You're open Thursday, Aug 6 3–5 PM if you want to set up a time."
  );

  const withoutTime = formatGoalSignalAlert({
    match: PARTNERSHIP_MATCH,
    signal: { from: 'matt@identityiq.com', subject: 'Reseller partnership' },
    windows: []
  });
  assert.doesNotMatch(withoutTime, /You're open/);
});

test('calendar signals ignore the owner and events with no other attendees', () => {
  assert.equal(calendarSignal({ id: 'e1', attendees: [] }), null);
  assert.equal(calendarSignal({ id: 'e2', attendees: [{ email: 'me@x.com', self: true }] }), null);
  const signal = calendarSignal({
    id: 'e3',
    summary: 'Intro call',
    attendees: [{ email: 'me@x.com', self: true }, { email: 'matt@identityiq.com', displayName: 'Matt Rivera' }]
  });
  assert.equal(signal.address, 'matt@identityiq.com');
  assert.equal(signal.subject, 'Intro call');
});

test('a goal alert carries the known contact and their client standing', async () => {
  const harness = goalSignalHarness({
    links: {
      people: [{
        key: 'people.matt_rivera',
        name: 'Matt Rivera',
        organization: 'Identity IQ',
        role: 'VP Partnerships',
        confidence: 0.99,
        identified: true,
        evidence: { matched_on: 'email' }
      }],
      clients: [{
        found: true,
        client: { name: 'Identity IQ', status: 'Active', billing_status: 'Current' },
        current_phase: 'Phase 2',
        outstanding_total: 1250
      }]
    }
  });
  await harness.run();

  harness.setNow('2026-08-03T16:05:00Z');
  harness.setEmails([{
    id: 'email-linked',
    from: '"Matt Rivera" <matt@identityiq.com>',
    subject: 'Reseller partnership',
    snippet: 'Following up on the agreement.'
  }]);
  await harness.run();

  const alert = harness.alerts.find(item => item.category === 'goal_signal');
  assert.match(alert.text, /Known contact: Matt Rivera — VP Partnerships at Identity IQ\./);
  assert.match(alert.text, /CCC: Identity IQ — Phase 2 · Active · Current · \$1250\.00 outstanding\./);
  assert.equal(alert.options.metadata.linked_people, 1);
  assert.equal(alert.options.metadata.linked_clients, 1);
  assert.equal(harness.recorded[0].links.people[0].name, 'Matt Rivera');
});

test('a company-level person link is worded as context, not identification', () => {
  const text = formatGoalSignalAlert({
    match: PARTNERSHIP_MATCH,
    signal: { from: '"Priya Nair" <priya@identityiq.com>', subject: 'Intro' },
    windows: [],
    links: {
      people: [{
        name: 'Matt Rivera',
        organization: 'Identity IQ',
        role: 'VP Partnerships',
        identified: false,
        evidence: { matched_on: 'domain' }
      }]
    }
  });

  assert.match(text, /Possibly related: Matt Rivera — VP Partnerships at Identity IQ\./);
  assert.doesNotMatch(text, /Known contact/);
});

test('an alert with no links is unchanged', () => {
  const text = formatGoalSignalAlert({
    match: PARTNERSHIP_MATCH,
    signal: { from: '"Matt Rivera" <matt@identityiq.com>', subject: 'Reseller partnership' },
    windows: IDENTITY_IQ_WINDOWS,
    links: {}
  });
  assert.doesNotMatch(text, /Known contact|Possibly related|CCC:/);
  assert.match(text, /You're open Thursday, Aug 6 3–5 PM/);
});
