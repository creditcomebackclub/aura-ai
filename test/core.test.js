const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { MemoryStore } = require('../memory_store');
const {
  ConversationSummaryService,
  MemoryV2,
  buildProfileContext,
  deterministicEntries,
  findProfileMatches,
  parseMemoryCommand
} = require('../memory_v2');
const { brainRequestOptions, resolveModelConfig } = require('../model_router');
const {
  getToolPolicy,
  parseAndAuthorizeToolCall,
  validatePublicSearchInput
} = require('../agent_policy');
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

test('web searches require a bounded non-empty query', () => {
  assert.equal(
    parseAndAuthorizeToolCall(toolCall('search_web', { query: 'latest Sebastian weather' })).policy,
    'read'
  );
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('search_web', { query: '   ' })),
    /query is required/
  );
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('search_web', { query: 'x'.repeat(501) })),
    /query is too long/
  );
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('search_web', {
      query: `search for api_key=${'a'.repeat(48)}`
    })),
    /credential or secret/
  );
});

test('public search input is isolated, bounded, and credential-safe', () => {
  assert.equal(
    validatePublicSearchInput('  weather in Sebastian Florida  '),
    'weather in Sebastian Florida'
  );
  assert.throws(() => validatePublicSearchInput('x'.repeat(1001)), /1000 characters/);
  assert.throws(
    () => validatePublicSearchInput(`my token is ${'a'.repeat(64)}`),
    /credential or secret/
  );
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

function createProfileStore(initialEntries = {}) {
  let profile = { version: 1, entries: { ...initialEntries }, updated_at: null };
  return {
    async getOwnerProfile() {
      return structuredClone(profile);
    },
    async upsertOwnerProfileEntries(entries) {
      for (const entry of entries) profile.entries[entry.key] = structuredClone(entry);
      return structuredClone(profile);
    },
    async removeOwnerProfileEntries(keys) {
      for (const key of keys) delete profile.entries[key];
      return structuredClone(profile);
    }
  };
}

function createSemanticMemory() {
  let nextId = 1;
  const rows = new Map();
  const superseded = [];
  return {
    rows,
    superseded,
    async save(content, options = {}) {
      const existing = [...rows.values()].find(row =>
        row.content.toLowerCase() === content.toLowerCase() && !row.superseded_by
      );
      if (existing) return { id: existing.id, deduplicated: true };
      const row = { id: nextId++, content, ...options };
      rows.set(row.id, row);
      return { id: row.id, deduplicated: false };
    },
    async search() {
      return [...rows.values()].filter(row => !row.superseded_by);
    },
    async list() {
      return [...rows.values()].filter(row => !row.superseded_by);
    },
    async forget(id) {
      return rows.delete(id);
    },
    async supersede(id, replacementId) {
      const row = rows.get(id);
      if (!row) return false;
      row.superseded_by = replacementId;
      superseded.push({ id, replacementId });
      return true;
    }
  };
}

function extractionClient(entries) {
  const queue = Array.isArray(entries[0]) ? [...entries] : [entries];
  return {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({ entries: queue.shift() || [] })
              }
            }]
          };
        }
      }
    }
  };
}

test('explicit remember, forget, and correction commands are deterministic', () => {
  assert.deepEqual(
    parseMemoryCommand('Remember that my preferred meeting time is 10 AM'),
    { type: 'remember', content: 'my preferred meeting time is 10 AM' }
  );
  assert.deepEqual(
    parseMemoryCommand('Forget about my preferred meeting time'),
    { type: 'forget', query: 'my preferred meeting time' }
  );
  assert.deepEqual(
    parseMemoryCommand('Correction: my preferred meeting time is 11 AM'),
    { type: 'correct', content: 'my preferred meeting time is 11 AM' }
  );
});

test('family relationships and permanent communication rules are extracted without a model', () => {
  const entries = deterministicEntries(
    "My daughters' names are Ava and Mia. Don't end every reply by saying if there is anything else."
  );
  assert.deepEqual(
    entries.filter(entry => entry.kind === 'relationship').map(entry => entry.value),
    ['Ava', 'Mia']
  );
  const communication = entries.find(entry => entry.key === 'communication.generic_signoff');
  assert.equal(communication.pinned, true);
  assert.match(communication.instruction, /Do not end responses/);
});

test('family relationships are recovered from a longer owner introduction', () => {
  const entries = deterministicEntries(
    'I have two daughters. They love art. Their names are Ava and Mia.'
  );
  assert.deepEqual(
    entries.filter(entry => entry.kind === 'relationship').map(entry => entry.value),
    ['Ava', 'Mia']
  );
});

test('pinned owner facts and communication preferences load on every turn', () => {
  const context = buildProfileContext({
    entries: {
      'people.ava': {
        key: 'people.ava',
        kind: 'relationship',
        value: 'Ava',
        subject: 'Ava',
        relationship: 'daughter',
        pinned: true
      },
      'communication.generic_signoff': {
        key: 'communication.generic_signoff',
        kind: 'communication',
        value: 'disabled',
        instruction: 'Do not use generic sign-offs.',
        pinned: true
      }
    }
  });
  assert.match(context, /Ava: relationship=daughter/);
  assert.match(context, /Do not use generic sign-offs/);
});

test('structured relationship lookup handles plural family language', () => {
  const matches = findProfileMatches({
    entries: {
      'people.ava': {
        key: 'people.ava',
        kind: 'relationship',
        value: 'Ava',
        subject: 'Ava',
        relationship: 'daughter',
        pinned: true
      }
    }
  }, "What is my daughter's name?");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].value, 'Ava');
});

test('automatic learning saves structured profile entries and semantic memory', async () => {
  const profileStore = createProfileStore();
  const semanticMemory = createSemanticMemory();
  const client = extractionClient([{
    key: 'preference.meeting_time',
    kind: 'preference',
    value: '10 AM',
    subject: '',
    relationship: '',
    instruction: 'Prefer meetings at 10 AM.',
    replaces_key: '',
    pinned: true,
    confidence: 0.95
  }]);
  const memory = new MemoryV2({ profileStore, semanticMemory, client });
  const result = await memory.learnFromUserMessage('I prefer meetings at 10 AM.');
  assert.equal(result.learned.length, 1);
  assert.equal((await profileStore.getOwnerProfile()).entries['preference.meeting_time'].value, '10 AM');
  assert.equal(semanticMemory.rows.size, 1);
});

test('model and deterministic communication preferences merge into one canonical rule', async () => {
  const profileStore = createProfileStore();
  const semanticMemory = createSemanticMemory();
  const client = extractionClient([{
    key: 'communication.avoid_closing_offer',
    kind: 'communication',
    value: 'Do not say if there is anything else.',
    subject: '',
    relationship: '',
    instruction: 'Avoid generic offers of additional help.',
    replaces_key: '',
    pinned: true,
    confidence: 0.95
  }]);
  const memory = new MemoryV2({ profileStore, semanticMemory, client });
  const result = await memory.learnFromUserMessage(
    "Don't end every reply by saying if there is anything else."
  );
  assert.equal(result.learned.length, 1);
  assert.equal(result.learned[0].key, 'communication.generic_signoff');
  assert.deepEqual(
    Object.keys((await profileStore.getOwnerProfile()).entries),
    ['communication.generic_signoff']
  );
});

test('explicit corrections supersede the old memory and replace its profile key', async () => {
  const profileStore = createProfileStore({
    'people.emily': {
      key: 'people.emily',
      kind: 'relationship',
      value: 'Emily',
      subject: 'Emily',
      relationship: 'daughter',
      pinned: true,
      memory_id: 1
    }
  });
  const semanticMemory = createSemanticMemory();
  await semanticMemory.save("Emily is the owner's daughter.", { kind: 'relationship' });
  const client = extractionClient([{
    key: 'people.emma',
    kind: 'relationship',
    value: 'Emma',
    subject: 'Emma',
    relationship: 'daughter',
    instruction: '',
    replaces_key: 'people.emily',
    pinned: true,
    confidence: 1
  }]);
  const memory = new MemoryV2({ profileStore, semanticMemory, client });
  await memory.learnFromUserMessage('Her name is Emma, not Emily.', {
    source: 'explicit_correction',
    explicit: true
  });
  const profile = await profileStore.getOwnerProfile();
  assert.equal(profile.entries['people.emily'], undefined);
  assert.equal(profile.entries['people.emma'].value, 'Emma');
  assert.deepEqual(semanticMemory.superseded, [{ id: 1, replacementId: 2 }]);
});

test('forget removes matching structured facts and linked semantic memories', async () => {
  const profileStore = createProfileStore({
    'people.ava': {
      key: 'people.ava',
      kind: 'relationship',
      value: 'Ava',
      subject: 'Ava',
      relationship: 'daughter',
      pinned: true,
      memory_id: 1
    },
    'people.mia': {
      key: 'people.mia',
      kind: 'relationship',
      value: 'Mia',
      subject: 'Mia',
      relationship: 'daughter',
      pinned: true,
      memory_id: 2
    }
  });
  const semanticMemory = createSemanticMemory();
  semanticMemory.rows.set(1, { id: 1, content: "Ava is the owner's daughter." });
  semanticMemory.rows.set(2, { id: 2, content: "Mia is the owner's daughter." });
  const memory = new MemoryV2({ profileStore, semanticMemory });
  const result = await memory.forget("my daughters' names");
  assert.equal(result.forgotten, true);
  assert.deepEqual((await profileStore.getOwnerProfile()).entries, {});
  assert.equal(semanticMemory.rows.size, 0);
});

test('rolling summaries update only after the message threshold', async () => {
  let update = null;
  const messages = Array.from({ length: 4 }, (_, index) => ({
    id: index + 1,
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index + 1}`
  }));
  const stateStore = {
    async messagesForSummary() {
      return { existingSummary: 'Earlier context.', messages };
    },
    async updateConversationSummary(summary, throughMessageId) {
      update = { summary, throughMessageId };
    }
  };
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{ message: { content: JSON.stringify({ summary: 'Updated context.' }) } }]
          };
        }
      }
    }
  };
  const service = new ConversationSummaryService({
    stateStore,
    client,
    minimumMessages: 4
  });
  assert.deepEqual(await service.maybeSummarize(), { updated: true, throughMessageId: 4 });
  assert.deepEqual(update, { summary: 'Updated context.', throughMessageId: 4 });
});

test('model routing defaults to Sol with Luna for memory work', () => {
  const config = resolveModelConfig({});
  assert.equal(config.primaryModel, 'gpt-5.6-sol');
  assert.equal(config.memoryModel, 'gpt-5.6-luna');
  assert.equal(config.reasoningEffort, 'medium');
  assert.deepEqual(
    brainRequestOptions(config, { messages: [] }),
    {
      messages: [],
      model: 'gpt-5.6-sol',
      reasoning_effort: 'medium'
    }
  );
  assert.deepEqual(
    brainRequestOptions(config, {
      messages: [],
      tools: [{ type: 'function', function: { name: 'lookup' } }]
    }),
    {
      messages: [],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      model: 'gpt-5.6-sol',
      reasoning_effort: 'none'
    }
  );
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
