'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXECUTIVE_LOOP_STATE_KEY,
  classifyEmail,
  extractOwnerCommitment,
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

function createHarness({ now = new Date('2026-08-03T16:00:00Z') } = {}) {
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
      return { deduplicated: duplicate };
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
