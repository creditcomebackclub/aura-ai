const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { MemoryStore } = require('../memory_store');
const { getToolPolicy, parseAndAuthorizeToolCall } = require('../agent_policy');
const {
  normalizePhaseLabel,
  isOutstanding,
  getLedgerTransactionDate,
  normalizeClientName,
  scoreClientName,
  rankClientMatches
} = require('../ccc_database');
const {
  checkBlackboardCalendarFeed,
  isIcsCalendar,
  parseBlackboardIcs
} = require('../scraper');
const { createBlackboardDeadlineCheck } = require('../blackboard_deadline_check');
const {
  createSchedulerAuthenticator,
  isValidCronSecret
} = require('../scheduler_auth');

function toolCall(name, args) {
  return { function: { name, arguments: JSON.stringify(args) } };
}

test('unknown tools are blocked by policy', () => {
  assert.equal(getToolPolicy('delete_everything'), 'blocked');
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('delete_everything', {})),
    /not authorized/
  );
});

test('tool arguments reject unsafe identifiers and invalid writes', () => {
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('query_database_table', { table_name: 'clients; drop table' })),
    /Invalid table name/
  );
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('update_goal_status', { id: 1, status: 'erased' })),
    /Invalid goal status/
  );
});

test('tool limits are clamped', () => {
  const parsed = parseAndAuthorizeToolCall(toolCall('query_finances', { limit: 5000 }));
  assert.equal(parsed.args.limit, 200);
});

test('memory deduplicates, retrieves relevant facts, and forgets', async () => {
  const db = new Database(':memory:');
  const vectors = {
    'Chris prefers concise answers': [1, 0],
    'What answer style does Chris prefer?': [0.98, 0.02],
    'A completely unrelated fact': [0, 1]
  };
  const store = new MemoryStore(db, async text => vectors[text]);

  const first = await store.save('Chris prefers concise answers');
  const duplicate = await store.save('Chris prefers concise answers');
  await store.save('A completely unrelated fact');

  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.deduplicated, true);
  const results = await store.search('What answer style does Chris prefer?', { threshold: 0.8 });
  assert.equal(results.length, 1);
  assert.equal(results[0].content, 'Chris prefers concise answers');
  assert.equal(store.forget(first.id), true);
  assert.equal(store.list().some(row => row.id === first.id), false);
  db.close();
});

test('memory degrades gracefully when embeddings fail', async () => {
  const db = new Database(':memory:');
  const store = new MemoryStore(db, async () => { throw new Error('offline'); });
  await store.save('A durable preference');
  assert.deepEqual(await store.search('preference'), []);
  assert.equal(store.list().length, 1);
  db.close();
});

test('bureau-specific letter labels become concise client phases', () => {
  assert.equal(normalizePhaseLabel('Phase 3 — Equifax'), 'Phase 3');
  assert.equal(normalizePhaseLabel('Phase 1 — FDCPA §1692g(b) Validation'), 'Phase 1');
  assert.equal(normalizePhaseLabel('Round 2 - Escalation'), 'Round 2');
  assert.equal(normalizePhaseLabel('Personal Info & Inquiries'), 'Personal Info & Inquiries');
});

test('client names tolerate punctuation, honorifics, and omitted middle names', () => {
  assert.deepEqual(normalizeClientName("Dr. Renée O'Connor's"), ['renee', 'o', 'connor']);
  assert.equal(scoreClientName('Jordan Smith', 'Jordan Lee Smith') > 0.8, true);
  assert.equal(scoreClientName('Jordan Smyth', 'Jordan Smith') > 0.85, true);
});

test('client matching selects a clear fuzzy winner but preserves ambiguity', () => {
  const clear = rankClientMatches('Jordan Smyth', [
    { id: 1, name: 'Jordan Smith' },
    { id: 2, name: 'Taylor Jones' }
  ]);
  assert.deepEqual(clear.map(client => client.id), [1]);

  const ambiguous = rankClientMatches('Jordan', [
    { id: 1, name: 'Jordan Smith' },
    { id: 2, name: 'Jordan Jones' }
  ]);
  assert.deepEqual(ambiguous.map(client => client.id), [2, 1]);
});

test('30-day income uses transaction date before import timestamp', () => {
  const importedEntry = {
    status: 'Paid',
    amount: 499,
    paid_at: null,
    date: '2026-05-01',
    created_at: '2026-07-22T12:00:00Z'
  };
  assert.equal(getLedgerTransactionDate(importedEntry).toISOString().slice(0, 10), '2026-05-01');

  const processorDatedEntry = {
    status: 'Paid',
    amount: 79,
    paid_at: '2026-07-24T10:00:00Z',
    date: '2026-07-23',
    created_at: '2026-07-26T12:00:00Z'
  };
  assert.equal(getLedgerTransactionDate(processorDatedEntry).toISOString().slice(0, 10), '2026-07-24');
});

test('only genuinely open ledger statuses count as outstanding', () => {
  assert.equal(isOutstanding('Due'), true);
  assert.equal(isOutstanding('Overdue'), true);
  assert.equal(isOutstanding('Paid'), false);
  assert.equal(isOutstanding('Cancelled'), false);
  assert.equal(isOutstanding('Refunded'), false);
});

test('Blackboard iCalendar events are parsed into structured assignments', () => {
  const events = parseBlackboardIcs([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'DTSTART;TZID=America/Phoenix:20260801T235900',
    'SUMMARY:Week 3\\, Written Assignment',
    'DESCRIPTION:Submit in Blackboard\\nWorth 100 points',
    'URL:https://example.edu/assignment/123',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n'));

  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Week 3, Written Assignment');
  assert.match(events[0].description, /Worth 100 points/);
  assert.equal(events[0].url, 'https://example.edu/assignment/123');
  assert.equal(events[0].due_at, '2026-08-02T06:59:00.000Z');
});

test('Blackboard calendar validation rejects an HTML login page', () => {
  assert.equal(isIcsCalendar('<html><title>Sign in</title></html>'), false);
  assert.equal(isIcsCalendar('BEGIN:VCALENDAR\r\nEND:VCALENDAR'), true);
});

test('Blackboard calendar feed rejects an HTTP 200 login page', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => '<html><title>Sign in</title></html>'
  });
  try {
    const result = await checkBlackboardCalendarFeed('https://example.edu/calendar.ics');
    assert.match(result, /^BLACKBOARD_CALENDAR_ERROR:/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('scheduler authentication fails closed and accepts only the configured secret', () => {
  const configuredSecret = 'a'.repeat(64);
  assert.equal(isValidCronSecret(configuredSecret), true);
  assert.equal(isValidCronSecret('too-short'), false);

  function invoke(expectedSecret, providedSecret) {
    const response = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      }
    };
    let nextCalled = false;
    createSchedulerAuthenticator(expectedSecret)(
      { get: () => providedSecret },
      response,
      () => { nextCalled = true; }
    );
    return { response, nextCalled };
  }

  assert.equal(invoke('', configuredSecret).response.statusCode, 503);
  assert.equal(invoke(configuredSecret, 'b'.repeat(64)).response.statusCode, 401);
  const authorized = invoke(configuredSecret, configuredSecret);
  assert.equal(authorized.response.statusCode, 200);
  assert.equal(authorized.nextCalled, true);
  assert.equal(JSON.stringify(invoke(configuredSecret, 'b'.repeat(64)).response.body).includes('b'.repeat(64)), false);
});

test('Blackboard deadline checks are deterministic and idempotent', async () => {
  const state = new Map();
  const alerts = [];
  let calendarReads = 0;
  const check = createBlackboardDeadlineCheck({
    now: () => new Date('2026-07-29T14:00:00Z'),
    checkAssignments: async () => {
      calendarReads += 1;
      return JSON.stringify({
        source: 'blackboard_ical',
        assignments: [
          {
            title: 'Week 5 Discussion',
            due_at: '2026-07-30T06:59:00Z'
          },
          {
            title: 'Later Assignment',
            due_at: '2026-08-10T06:59:00Z'
          }
        ]
      });
    },
    getAlertState: async key => state.get(key) ?? null,
    setAlertState: async (key, value) => state.set(key, value),
    sendAlert: async (text, category, urgency) => alerts.push({ text, category, urgency })
  });

  const first = await check();
  const retry = await check();

  assert.equal(first.status, 'complete');
  assert.equal(first.due_count, 1);
  assert.equal(retry.status, 'already_checked');
  assert.equal(calendarReads, 1);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Week 5 Discussion/);
  assert.equal(state.get('blackboard_digest_date'), '2026-07-29');
});

test('concurrent Blackboard scheduler calls share one active check', async () => {
  const state = new Map();
  let reads = 0;
  let releases;
  const blockedRead = new Promise(resolve => {
    releases = resolve;
  });
  const check = createBlackboardDeadlineCheck({
    now: () => new Date('2026-07-29T14:00:00Z'),
    checkAssignments: async () => {
      reads += 1;
      await blockedRead;
      return JSON.stringify({ source: 'blackboard_ical', assignments: [] });
    },
    getAlertState: async key => state.get(key) ?? null,
    setAlertState: async (key, value) => state.set(key, value),
    sendAlert: async () => {}
  });

  const first = check();
  const overlapping = check();
  releases();
  const [firstResult, overlappingResult] = await Promise.all([first, overlapping]);

  assert.equal(reads, 1);
  assert.equal(firstResult.status, 'complete');
  assert.equal(firstResult.due_count, 0);
  assert.deepEqual(overlappingResult, firstResult);
});

test('separate schedulers use the same durable Blackboard notification key', async () => {
  const state = new Map();
  const notificationKeys = new Set();
  let notificationsCreated = 0;
  const dependencies = {
    now: () => new Date('2026-07-29T14:00:00Z'),
    checkAssignments: async () => JSON.stringify({
      source: 'blackboard_ical',
      assignments: [{
        title: 'Week 5 Discussion',
        due_at: '2026-07-30T06:59:00Z'
      }]
    }),
    getAlertState: async key => state.get(key) ?? null,
    setAlertState: async (key, value) => state.set(key, value),
    sendAlert: async (_text, _category, _urgency, options) => {
      if (notificationKeys.has(options.dedupeKey)) return { deduplicated: true };
      notificationKeys.add(options.dedupeKey);
      notificationsCreated += 1;
      return { deduplicated: false };
    }
  };
  const macCheck = createBlackboardDeadlineCheck(dependencies);
  const cloudCheck = createBlackboardDeadlineCheck(dependencies);

  await Promise.all([macCheck(), cloudCheck()]);

  assert.equal(notificationsCreated, 1);
  assert.deepEqual([...notificationKeys], ['blackboard-deadlines:2026-07-29']);
});

test('separate schedulers deduplicate Blackboard source errors', async () => {
  const state = new Map();
  const notificationKeys = new Set();
  let notificationsCreated = 0;
  const dependencies = {
    now: () => new Date('2026-07-29T14:00:00Z'),
    checkAssignments: async () =>
      'BLACKBOARD_CALENDAR_ERROR: Calendar feed did not return iCalendar data.',
    getAlertState: async key => state.get(key) ?? null,
    setAlertState: async (key, value) => state.set(key, value),
    sendAlert: async (_text, _category, _urgency, options) => {
      if (notificationKeys.has(options.dedupeKey)) return { deduplicated: true };
      notificationKeys.add(options.dedupeKey);
      notificationsCreated += 1;
      return { deduplicated: false };
    }
  };

  await Promise.all([
    createBlackboardDeadlineCheck(dependencies)(),
    createBlackboardDeadlineCheck(dependencies)()
  ]);

  assert.equal(notificationsCreated, 1);
  assert.deepEqual(
    [...notificationKeys],
    ['blackboard-error:BLACKBOARD_CALENDAR_ERROR:2026-07-29']
  );
});
