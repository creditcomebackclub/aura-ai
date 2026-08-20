const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { MemoryStore } = require('../memory_store');
const {
  ConversationSummaryService,
  MemoryV2,
  buildProfileContext,
  classifyMemoryConfirmationReply,
  deterministicEntries,
  findFalseCapabilityDenial,
  findProfileMatches,
  findSelfCapabilityNegation,
  mergeRelationshipEntry,
  parseMemoryCommand,
  renderMemoryDocument,
  selectPendingConfirmation,
  selectPinnedProfileEntries
} = require('../memory_v2');
const {
  brainRequestOptions,
  resolveModelConfig,
  resolveTranscribeModel,
  resolveXaiReasoningEffort,
  shouldUsePrimaryForRoundZero
} = require('../model_router');
const {
  OWNER_SEARCH_INPUT_MAX_LENGTH,
  containsSearchSecret,
  getToolPolicy,
  isExplicitSkillManagementRequest,
  parseAndAuthorizeToolCall,
  resolveOwnerSearchInput,
  validatePublicSearchInput
} = require('../agent_policy');
const {
  isClearOwnerApproval,
  isClearOwnerRefusal
} = require('../owner_approval');
const {
  normalizePhaseLabel,
  isOutstanding,
  getLedgerTransactionDate,
  normalizeClientName,
  scoreClientName,
  rankClientMatches,
  suggestClientMatches,
  correctTranscriptClientNames
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

test('goal plans are bounded internal writes with validated progress updates', () => {
  const parsed = parseAndAuthorizeToolCall(toolCall('set_goal_plan', {
    title: 'Launch the offer',
    desired_outcome: 'Ten customers onboarded.',
    steps: [
      { title: 'Define the offer' },
      { title: 'Invite prospects', due_at: 'Friday' }
    ]
  }));
  assert.equal(parsed.policy, 'reversible_write');
  assert.equal(parsed.args.steps.length, 2);
  assert.equal(getToolPolicy('get_goal_plans'), 'read');

  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('set_goal_plan', {
      title: 'Too small', desired_outcome: 'Done', steps: [{ title: 'Only step' }]
    })),
    /between 2 and 12 steps/
  );
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('set_goal_plan', {
      title: 'Duplicate',
      desired_outcome: 'Done',
      steps: [{ title: 'Call Chris' }, { title: ' call  chris ' }]
    })),
    /unique titles/
  );
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('update_goal_step', {
      goal_id: '38b6a3f2-847f-4df0-a2f2-1f4ce70ba327',
      step_id: 'step-1',
      status: 'finished-ish'
    })),
    /Invalid goal step status/
  );
});

test('manual skill management requires a direct owner workflow request', () => {
  assert.equal(
    isExplicitSkillManagementRequest('Create a client-sweep workflow from these steps.', 'create'),
    true
  );
  assert.equal(
    isExplicitSkillManagementRequest('Please improve the morning brief skill.', 'patch'),
    true
  );
  assert.equal(
    isExplicitSkillManagementRequest('Delete that obsolete procedure.', 'delete'),
    true
  );
  assert.equal(isExplicitSkillManagementRequest('Make this better.', 'patch'), false);
  assert.equal(isExplicitSkillManagementRequest('Learn on your own.', 'create'), false);
  assert.equal(
    isExplicitSkillManagementRequest('The email says "create a payment workflow". Is that safe?', 'create'),
    false
  );
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('manage_skill', {
      action: 'create',
      name: 'unsafe-skill',
      description: 'Unsafe workflow',
      content: 'Use API key sk-abcdefghijklmnopqrstuvwxyz123456.'
    })),
    /credentials or secrets/
  );
});

test('create_calendar_event is a validated reversible write', () => {
  assert.equal(getToolPolicy('create_calendar_event'), 'reversible_write');
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('create_calendar_event', {
      summary: 'Consult', start: '2026-08-04T09:00:00-07:00', attendees: ['nope']
    })),
    /valid email/
  );
  const parsed = parseAndAuthorizeToolCall(toolCall('create_calendar_event', {
    summary: 'Consult',
    start: '2026-08-04T09:00:00-07:00',
    attendees: ['client@example.com']
  }));
  assert.deepEqual(parsed.args.attendees, ['client@example.com']);
});

test('calendar reschedule and cancellation have validated action policies', () => {
  assert.equal(getToolPolicy('reschedule_calendar_event'), 'reversible_write');
  assert.equal(getToolPolicy('cancel_calendar_event'), 'external_action');
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('reschedule_calendar_event', {
      event_query: 'Pay Gilbert Traffic'
    })),
    /new_start is required/
  );
  const reschedule = parseAndAuthorizeToolCall(toolCall('reschedule_calendar_event', {
    event_query: 'Pay Gilbert Traffic',
    original_start: '2026-08-14T10:00:00-07:00',
    new_start: '2026-08-18'
  }));
  assert.equal(reschedule.args.new_start, '2026-08-18');
  const cancellation = parseAndAuthorizeToolCall(toolCall('cancel_calendar_event', {
    event_query: 'Pay Gilbert Traffic'
  }));
  assert.equal(cancellation.args.event_query, 'Pay Gilbert Traffic');
});

test('set_reminder validates a durable recurrence', () => {
  assert.equal(getToolPolicy('set_reminder'), 'reversible_write');
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('set_reminder', {
      message: 'Discussion post', when: 'Thursday at 9 AM', recurrence: 'sometimes'
    })),
    /once, daily, or weekly/
  );
  const parsed = parseAndAuthorizeToolCall(toolCall('set_reminder', {
    message: 'Discussion post', when: 'Thursday at 9 AM', recurrence: 'weekly'
  }));
  assert.equal(parsed.args.recurrence, 'weekly');
  assert.equal(getToolPolicy('get_reminders'), 'read');
  assert.equal(getToolPolicy('cancel_reminder'), 'reversible_write');
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('cancel_reminder', { id: 'made-up' })),
    /Reminder id/
  );
});

test('send_email requires a valid recipient address, unlike the fixed-recipient owner tools', () => {
  // The asymmetry itself is the safety-relevant fact here: send_owner_email
  // and send_telegram_message deliberately have no recipient argument at all
  // (fixed server-side), while send_email is the one tool where a
  // recipient is a real argument - so it's the one place format validation
  // actually matters.
  assert.equal(getToolPolicy('send_owner_email'), 'destructive_write');
  assert.equal(getToolPolicy('send_email'), 'external_action');
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('send_email', {
      to: 'not-an-email', subject: 'hi', body: 'hello'
    })),
    /not a valid email address/
  );
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('send_email', {
      subject: 'hi', body: 'hello'
    })),
    /to is required/
  );
  const parsed = parseAndAuthorizeToolCall(toolCall('send_email', {
    to: 'admin@blackboard.example.edu', subject: 'hi', body: 'hello'
  }));
  assert.equal(parsed.args.to, 'admin@blackboard.example.edu');

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

// processOwnerText accepts messages up to 10,000 characters, but the owner's
// message can only stand in AS the search input while it is short enough to be
// one. It used to be validated against the 1,000-character default instead, so
// every message in between was accepted by the conversation and then failed
// every web search in that turn - length-dependent, so it looked random.
test('an over-long owner message falls back to the model query instead of failing the search', () => {
  const shortMessage = 'what is the weather in Sebastian Florida';
  assert.equal(resolveOwnerSearchInput(shortMessage), shortMessage);

  // Exactly at the cap the owner's own words are still used verbatim.
  // Filler is deliberately non-hex: a long [a-f0-9] run is itself one of the
  // secret patterns, and this test is about length alone.
  const atCap = 'z'.repeat(OWNER_SEARCH_INPUT_MAX_LENGTH);
  assert.equal(resolveOwnerSearchInput(atCap), atCap);

  // One character past it, and everywhere across the 1,001-10,000 range that
  // processOwnerText accepts, resolution yields null rather than throwing.
  // null is what makes handleToolCall's `options.publicSearchInput ||
  // args.query` fall through to the model's own distilled query.
  for (const length of [OWNER_SEARCH_INPUT_MAX_LENGTH + 1, 2500, 9999, 10000]) {
    assert.equal(
      resolveOwnerSearchInput('z'.repeat(length)),
      null,
      `expected a ${length}-character message to fall back, not throw`
    );
  }

  // The realistic shape: a pasted article with a short question in it. The
  // question is what the model puts in args.query; the paste no longer kills
  // the search on its way there.
  const pastedArticle = `${'lorem ipsum dolor sit amet '.repeat(200)}\n\nIs any of this still accurate?`;
  assert.ok(pastedArticle.length > OWNER_SEARCH_INPUT_MAX_LENGTH);
  assert.ok(pastedArticle.length <= 10000);
  assert.equal(resolveOwnerSearchInput(pastedArticle), null);

  // Falling back is not a hole: the model's query is independently bounded.
  assert.throws(
    () => parseAndAuthorizeToolCall(toolCall('search_web', { query: 'z'.repeat(501) })),
    /query is too long/
  );
});

test('a pasted credential blocks a public search at any owner message length', () => {
  const secret = `my api_key = ${'a'.repeat(48)}`;
  const longMessageWithSecret = `${'context. '.repeat(400)}${secret}`;
  assert.ok(longMessageWithSecret.length > OWNER_SEARCH_INPUT_MAX_LENGTH);

  // Length no longer short-circuits the credential screen - previously this
  // threw the length error first, so the more serious reason was never named.
  for (const value of [secret, longMessageWithSecret]) {
    assert.throws(
      () => resolveOwnerSearchInput(value),
      error => error.code === 'WEB_SEARCH_SECRET_IN_INPUT' && /credential or secret/.test(error.message)
    );
  }

  assert.throws(() => resolveOwnerSearchInput('   '), /public web search request is required/);
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
  // Lexical fallback still finds token overlap without embeddings.
  const results = await store.search('preference', { lexicalThreshold: 0.3 });
  assert.equal(results.length, 1);
  assert.equal(results[0].content, 'A durable preference');
  assert.equal(store.list().length, 1);
  db.close();
});

function createProfileStore(initialEntries = {}) {
  let profile = { version: 1, entries: { ...initialEntries }, memory_candidates: [], updated_at: null };
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
    },
    async setOwnerMemoryCandidates(candidates) {
      profile.memory_candidates = structuredClone(candidates);
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

test('uncertain preferences wait for explicit confirmation before persistence', async () => {
  const profileStore = createProfileStore();
  const semanticMemory = createSemanticMemory();
  const client = extractionClient([{
    key: 'preference.meeting_time',
    kind: 'preference',
    value: 'morning meetings',
    subject: '',
    relationship: '',
    instruction: 'Prefer morning meetings.',
    replaces_key: '',
    pinned: true,
    confidence: 0.72
  }]);
  const memory = new MemoryV2({ profileStore, semanticMemory, client });

  const staged = await memory.learnFromUserMessage('I might prefer morning meetings.');
  assert.equal(staged.learned.length, 0);
  assert.equal(staged.candidates.length, 1);
  assert.equal(semanticMemory.rows.size, 0);
  assert.deepEqual((await profileStore.getOwnerProfile()).entries, {});

  const pending = await memory.getPendingConfirmation();
  assert.equal(pending.question, 'Should I remember that you prefer morning meetings?');
  const contextBeforeConfirmation = await memory.buildContext('What do I prefer?', {
    includeSemantic: false,
    includeAlwaysOn: false
  });
  assert.equal(contextBeforeConfirmation.pendingConfirmation.id, pending.id);
  assert.doesNotMatch(contextBeforeConfirmation.profileContext, /morning meetings/i);
  assert.match(
    renderMemoryDocument({ profile: await profileStore.getOwnerProfile() }).markdown,
    /Pending Preference Confirmation[\s\S]*not saved yet/
  );
  const confirmed = await memory.resolvePendingConfirmation(pending.id, true);
  assert.equal(confirmed.resolved, true);
  assert.equal(confirmed.learned[0].source, 'confirmed_preference');
  assert.equal(semanticMemory.rows.size, 1);
  assert.equal(
    (await profileStore.getOwnerProfile()).entries['preference.meeting_time'].value,
    'morning meetings'
  );
  assert.equal(await memory.getPendingConfirmation(), null);
});

test('rejected and background-inferred preferences never enter durable memory', async () => {
  const profileStore = createProfileStore();
  const semanticMemory = createSemanticMemory();
  const client = extractionClient([{
    key: 'preference.summary_day',
    kind: 'preference',
    value: 'Friday summaries',
    subject: '',
    relationship: '',
    instruction: 'Prefer summaries on Friday.',
    replaces_key: '',
    pinned: true,
    confidence: 0.98
  }]);
  const memory = new MemoryV2({ profileStore, semanticMemory, client });
  const staged = await memory.learnFromUserMessage('Friday summaries seem useful.', {
    source: 'learning_review',
    explicit: true
  });
  assert.equal(staged.learned.length, 0);
  assert.equal(staged.candidates.length, 1);
  const rejected = await memory.resolvePendingConfirmation(staged.candidates[0].id, false);
  assert.equal(rejected.resolved, true);
  assert.equal(semanticMemory.rows.size, 0);
  assert.deepEqual((await profileStore.getOwnerProfile()).entries, {});
});

test('memory confirmation replies are strict and reject mixed requests', () => {
  assert.equal(classifyMemoryConfirmationReply('Yes, remember that.'), 'approved');
  assert.equal(classifyMemoryConfirmationReply('No thanks.'), 'rejected');
  assert.equal(classifyMemoryConfirmationReply('Yes, and check my calendar.'), null);
  assert.equal(classifyMemoryConfirmationReply('Do it'), null);
});

test('episodic memory records notable outcomes without polluting the owner profile', async () => {
  const profileStore = createProfileStore();
  const semanticMemory = createSemanticMemory();
  const memory = new MemoryV2({ profileStore, semanticMemory, client: null });
  const result = await memory.rememberEpisode({
    summary: 'Chris corrected the client sweep after an inactive account was reported as active.',
    outcome: 'The workflow was revised to verify status before reporting.',
    entities: ['client sweep', 'account status'],
    importance: 0.9
  });
  assert.equal(result.saved, true);
  const [episode] = await memory.listEpisodes();
  assert.equal(episode.kind, 'episode');
  assert.equal(episode.source, 'learning_review');
  assert.match(episode.content, /Outcome: The workflow was revised/);
  assert.deepEqual((await profileStore.getOwnerProfile()).entries, {});
});

test('episodic memory rejects routine or secret-bearing events', async () => {
  const memory = new MemoryV2({
    profileStore: createProfileStore(),
    semanticMemory: createSemanticMemory(),
    client: null
  });
  assert.equal((await memory.rememberEpisode({
    summary: 'A routine greeting happened.',
    importance: 0.2
  })).reason, 'low_importance');
  assert.equal((await memory.rememberEpisode({
    summary: 'The API key was sk-abcdefghijklmnopqrstuvwxyz123456.',
    importance: 1
  })).reason, 'contains_secret');
});

test('relationship memory preserves and merges durable contact context', async () => {
  const profileStore = createProfileStore();
  const semanticMemory = createSemanticMemory();
  const base = {
    key: 'people.sarah_chen', kind: 'relationship', value: 'Sarah Chen', subject: 'Sarah Chen',
    relationship: 'accountant', aliases: ['Sarah'], emails: ['sarah@example.com'], phones: [],
    organization: 'Chen Accounting', role: 'CPA', preferences: ['prefers email'], commitments: [],
    last_context: 'Preparing the quarterly books', instruction: '', replaces_key: '', pinned: true, confidence: 1
  };
  const update = {
    ...base,
    aliases: [], emails: [], organization: '', role: '', preferences: [],
    commitments: ['Send Q2 statements Friday'], last_context: 'Waiting on Q2 statements'
  };
  const memory = new MemoryV2({ profileStore, semanticMemory, client: extractionClient([[base], [update]]) });
  await memory.learnFromUserMessage('Sarah Chen is my accountant at Chen Accounting. Her email is sarah@example.com and she prefers email.');
  await memory.learnFromUserMessage('Sarah is waiting on the Q2 statements I promised Friday.');

  const entry = (await profileStore.getOwnerProfile()).entries['people.sarah_chen'];
  assert.deepEqual(entry.aliases, ['Sarah']);
  assert.deepEqual(entry.emails, ['sarah@example.com']);
  assert.equal(entry.organization, 'Chen Accounting');
  assert.deepEqual(entry.commitments, ['Send Q2 statements Friday']);
  assert.match(buildProfileContext({ entries: { 'people.sarah_chen': entry } }), /Waiting on Q2 statements/);
  assert.equal(findProfileMatches({ entries: { 'people.sarah_chen': entry } }, 'sarah@example.com')[0].subject, 'Sarah Chen');
});

test('concurrent learns serialize so a slow extract cannot clobber another write', async () => {
  const profileStore = createProfileStore();
  const semanticMemory = createSemanticMemory();
  let releaseFirstExtract;
  const firstExtractGate = new Promise(resolve => { releaseFirstExtract = resolve; });
  let extractCalls = 0;
  const client = {
    chat: {
      completions: {
        async create({ messages }) {
          extractCalls += 1;
          const text = messages.find(message => message.role === 'user')?.content || '';
          if (extractCalls === 1) await firstExtractGate;
          const value = text.includes('Maya') ? 'Maya' : 'Emma';
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  entries: [{
                    key: `people.${value.toLowerCase()}`,
                    kind: 'relationship',
                    value,
                    subject: value,
                    relationship: 'daughter',
                    instruction: '',
                    replaces_key: '',
                    pinned: true,
                    confidence: 1
                  }]
                })
              }
            }]
          };
        }
      }
    }
  };
  const memory = new MemoryV2({ profileStore, semanticMemory, client });
  const first = memory.learnFromUserMessage('Remember my daughter is Maya');
  // Let the first learn enter extract before starting the second.
  await new Promise(resolve => setImmediate(resolve));
  const second = memory.learnFromUserMessage('Remember my daughter is Emma');
  releaseFirstExtract();
  await Promise.all([first, second]);

  const entries = (await profileStore.getOwnerProfile()).entries;
  assert.equal(entries['people.maya']?.value, 'Maya');
  assert.equal(entries['people.emma']?.value, 'Emma');
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

test('buildContext can skip semantic search for lightweight turns', async () => {
  const profileStore = createProfileStore({
    'preference.tone': {
      key: 'preference.tone',
      kind: 'preference',
      value: 'direct',
      pinned: true,
      confidence: 1
    }
  });
  let searchCalls = 0;
  const semanticMemory = createSemanticMemory();
  const originalSearch = semanticMemory.search.bind(semanticMemory);
  semanticMemory.search = async (...args) => {
    searchCalls += 1;
    return originalSearch(...args);
  };
  const memory = new MemoryV2({ profileStore, semanticMemory });
  const light = await memory.buildContext('hey', { includeSemantic: false, includeAlwaysOn: false });
  assert.equal(searchCalls, 0);
  assert.equal(light.alwaysOnContext, '');
  assert.ok(light.profileContext);
  const full = await memory.buildContext('hey', { includeSemantic: true });
  assert.equal(searchCalls, 1);
  assert.ok(full.profileContext);
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
  assert.deepEqual(
    await service.maybeSummarize(),
    { updated: true, throughMessageId: 4, flagged: false, snippet: null }
  );
  assert.deepEqual(update, { summary: 'Updated context.', throughMessageId: 4 });
});

test('a regenerated summary that negates AURA\'s own capabilities still saves, but is flagged', async () => {
  let update = null;
  const messages = [{ id: 1, role: 'user', content: 'does AURA have database access?' }];
  const poisoned = 'Do not claim access to the CCC database without verified tool output.';
  const stateStore = {
    async messagesForSummary() {
      return { existingSummary: '', messages };
    },
    async updateConversationSummary(summary, throughMessageId) {
      update = { summary, throughMessageId };
    }
  };
  const client = {
    chat: {
      completions: {
        async create() {
          return { choices: [{ message: { content: JSON.stringify({ summary: poisoned }) } }] };
        }
      }
    }
  };
  const service = new ConversationSummaryService({ stateStore, client, minimumMessages: 1 });
  const result = await service.maybeSummarize();
  assert.equal(result.flagged, true);
  assert.match(result.snippet, /do not claim access/i);
  // The save is non-blocking - a false positive here must not cost genuinely
  // new continuity info, so it always saves regardless of the flag.
  assert.deepEqual(update, { summary: poisoned, throughMessageId: 1 });
});

test('findSelfCapabilityNegation catches the actual incident string and ignores adjacent-but-benign text', () => {
  const positive = findSelfCapabilityNegation(
    'Do not claim access to the CCC database without verified tool output.'
  );
  assert.ok(positive);
  assert.match(positive.snippet, /do not claim access/i);

  for (const benign of [
    'The client has no access to their bank statement.',
    'Remember to call the client back tomorrow.',
    'Chris said Karl Elliott has no access to his online portal yet.'
  ]) {
    assert.equal(findSelfCapabilityNegation(benign), null, benign);
  }
});

test('owner approval requires an approval-shaped message, not a bare approval word in a mixed turn', () => {
  for (const approval of [
    'yes',
    'Yeah',
    'send it',
    'go ahead',
    'approve',
    'permission granted',
    'Yes, send the email.',
    'Confirmed — delete it.',
    // Natural assent around an approval word must still redeem.
    "yes that's fine",
    "That's fine, send it",
    'sounds good, send it',
    'yes please',
    'ok go ahead',
    'yes, schedule it',
    'yes create the event'
  ]) {
    assert.equal(isClearOwnerApproval(approval), true, approval);
    assert.equal(isClearOwnerRefusal(approval), false, approval);
  }

  for (const mixed of [
    'yes, also can you check my email',
    'Yes, pull up Mary\'s balance',
    'Can you send a Telegram that I\'m late?',
    'please proceed with the client outreach plan tomorrow',
    'approve the budget after you check the ledger'
  ]) {
    assert.equal(isClearOwnerApproval(mixed), false, mixed);
  }

  for (const refusal of ['no', "don't", 'cancel', 'hold off', "don't send it", 'wait']) {
    assert.equal(isClearOwnerRefusal(refusal), true, refusal);
    assert.equal(isClearOwnerApproval(refusal), false, refusal);
  }

  assert.equal(isClearOwnerApproval('not sure'), false);
  assert.equal(isClearOwnerApproval('maybe later'), false);
  assert.equal(isClearOwnerApproval(''), false);
});

test('findFalseCapabilityDenial only fires when the denied capability was actually offered', () => {
  const denial = findFalseCapabilityDenial(
    "I don't have access to the client database.",
    ['get_client_snapshot', 'check_email']
  );
  assert.ok(denial);
  assert.ok(denial.tools.includes('get_client_snapshot'));

  assert.equal(
    findFalseCapabilityDenial(
      "I don't have access to the client database.",
      ['check_email', 'search_web']
    ),
    null,
    'database denial must not fire when business tools were not offered'
  );

  assert.equal(
    findFalseCapabilityDenial(
      'The client has no access to their bank statement.',
      ['get_client_snapshot']
    ),
    null,
    'benign client-language must not count as a self-denial'
  );

  const emailDenial = findFalseCapabilityDenial(
    "I can't check email from here.",
    ['check_email']
  );
  assert.ok(emailDenial);
  assert.deepEqual(emailDenial.tools, ['check_email']);

  const calendarWriteDenial = findFalseCapabilityDenial(
    "I don't actually have the calendar create tools available right now — only read. So I can't put lunch with Mike on the calendar from here.",
    ['check_calendar', 'create_calendar_event']
  );
  assert.ok(calendarWriteDenial);
  assert.ok(calendarWriteDenial.tools.includes('create_calendar_event'));

  const calendarLifecycleDenial = findFalseCapabilityDenial(
    "I can't reschedule or cancel calendar events with the tools available in this chat.",
    ['check_calendar', 'reschedule_calendar_event', 'cancel_calendar_event']
  );
  assert.ok(calendarLifecycleDenial);
  assert.ok(calendarLifecycleDenial.tools.includes('reschedule_calendar_event'));
  assert.ok(calendarLifecycleDenial.tools.includes('cancel_calendar_event'));
});

test('findFalseCapabilityDenial catches generic tool-availability wording across capabilities', () => {
  const plateDenial = findFalseCapabilityDenial(
    "I don’t have your live calendar, Blackboard deadlines, or goals loaded in this chat.",
    ['check_calendar', 'check_blackboard', 'get_goals', 'get_goal_plans']
  );
  assert.ok(plateDenial);
  assert.deepEqual(new Set(plateDenial.tools), new Set([
    'check_calendar', 'check_blackboard', 'get_goals', 'get_goal_plans'
  ]));

  const mailDenial = findFalseCapabilityDenial(
    "I don’t have mail access in the tools I can call right now.",
    ['check_email']
  );
  assert.ok(mailDenial);
  assert.deepEqual(mailDenial.tools, ['check_email']);

  const webDenial = findFalseCapabilityDenial(
    "I don’t have a web-search tool available in this chat right now.",
    ['search_web']
  );
  assert.ok(webDenial);
  assert.deepEqual(webDenial.tools, ['search_web']);

  const genericDenial = findFalseCapabilityDenial(
    "I don't have the tools I need available in this chat.",
    ['check_email', 'check_calendar']
  );
  assert.ok(genericDenial);
  assert.equal(genericDenial.generic, true);
});

test('findFalseCapabilityDenial ignores capabilities already attempted this turn', () => {
  assert.equal(
    findFalseCapabilityDenial(
      "I don’t have your live calendar loaded in this chat.",
      ['check_calendar'],
      { attemptedToolNames: ['check_calendar'] }
    ),
    null
  );
});

test('search secret patterns catch common cloud and VCS tokens', () => {
  for (const secret of [
    `ghp_${'a'.repeat(36)}`,
    `xoxb-${'a'.repeat(12)}-${'b'.repeat(24)}`,
    'AKIAIOSFODNN7EXAMPLE',
    `sb_secret_${'c'.repeat(24)}`,
    `Bearer ${'d'.repeat(32)}`
  ]) {
    assert.equal(containsSearchSecret(secret), true, secret);
    assert.throws(
      () => resolveOwnerSearchInput(`was this leaked? ${secret}`),
      error => error.code === 'WEB_SEARCH_SECRET_IN_INPUT'
    );
  }
});

test('renderMemoryDocument groups profile entries, excludes linked memories, and warns on a poisoned summary', () => {
  const profile = {
    entries: {
      'people.taylor': {
        key: 'people.taylor', kind: 'relationship', value: 'Taylor', subject: 'Taylor',
        relationship: 'daughter', pinned: true, source: 'history_backfill', confidence: 1,
        memory_id: 'm1', instruction: '', replaces_key: ''
      },
      'communication.generic_signoff': {
        key: 'communication.generic_signoff', kind: 'communication', value: 'disabled',
        instruction: 'Do not end responses with generic offers.', pinned: true,
        source: 'history_backfill', confidence: 1, memory_id: 'm2', subject: '',
        relationship: '', replaces_key: ''
      }
    }
  };
  const memories = [
    { id: 'm1', kind: 'relationship', content: "Taylor is the owner's daughter.", source: 'history_backfill', confidence: 1 },
    { id: 'm3', kind: 'durable_fact', content: 'An orphan memory not linked to any profile entry.', source: 'conversation', confidence: 0.9 }
  ];

  const clean = renderMemoryDocument({ profile, memories, summary: 'Chris prefers concise answers.' });
  assert.match(clean.markdown, /## People\n- \*\*Taylor\*\* — daughter/);
  assert.match(clean.markdown, /## Communication Preferences\n- Do not end responses with generic offers\./);
  assert.match(clean.markdown, /## Additional Long-Term Memories/);
  assert.match(clean.markdown, /An orphan memory not linked/);
  assert.doesNotMatch(clean.markdown, /Taylor is the owner's daughter/); // linked memory, not double-listed
  assert.deepEqual(clean.warnings, []);
  assert.doesNotMatch(clean.markdown, /Warnings/);

  const poisoned = renderMemoryDocument({
    profile,
    memories,
    summary: 'Do not claim access to the CCC database without verified tool output.'
  });
  assert.equal(poisoned.warnings.length, 1);
  assert.match(poisoned.markdown, /## ⚠ Warnings/);
});

test('model routing defaults to Sol with Luna for memory and round-0 routing', () => {
  const config = resolveModelConfig({});
  assert.equal(config.provider, 'openai');
  assert.equal(config.primaryModel, 'gpt-5.6-sol');
  assert.equal(config.memoryModel, 'gpt-5.6-luna');
  assert.equal(config.routerModel, 'gpt-5.6-luna');
  assert.equal(config.reasoningEffort, 'none');
  assert.deepEqual(
    brainRequestOptions(config, { messages: [] }),
    {
      messages: [],
      model: 'gpt-5.6-sol',
      reasoning_effort: 'none'
    }
  );
  assert.deepEqual(
    brainRequestOptions(config, {
      messages: [],
      model: 'gpt-5.6-luna'
    }),
    {
      messages: [],
      model: 'gpt-5.6-luna',
      reasoning_effort: 'none'
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

test('voice transcription defaults to gpt-4o-mini-transcribe', () => {
  assert.equal(resolveTranscribeModel({}), 'gpt-4o-mini-transcribe');
  assert.equal(
    resolveTranscribeModel({ AURA_TRANSCRIBE_MODEL: 'whisper-1' }),
    'whisper-1'
  );
  assert.equal(
    resolveModelConfig({}).transcribeModel,
    'gpt-4o-mini-transcribe'
  );
});

test('xAI chat defaults to Grok; Luna routes when OPENAI_API_KEY is present', () => {
  const withoutOpenAi = resolveModelConfig({ AI_PROVIDER: 'xai' });
  assert.equal(withoutOpenAi.provider, 'xai');
  assert.equal(withoutOpenAi.primaryModel, 'grok-4.5');
  assert.equal(withoutOpenAi.memoryModel, 'gpt-5.6-luna');
  assert.equal(withoutOpenAi.routerModel, null);
  assert.equal(withoutOpenAi.reasoningEffort, 'low');

  const withOpenAi = resolveModelConfig({
    AI_PROVIDER: 'xai',
    OPENAI_API_KEY: 'sk-test'
  });
  assert.equal(withOpenAi.routerModel, 'gpt-5.6-luna');
  assert.equal(
    brainRequestOptions(withOpenAi, {
      messages: [],
      model: 'gpt-5.6-luna',
      tools: [{ type: 'function', function: { name: 'lookup' } }]
    }).reasoning_effort,
    'none'
  );
  assert.equal(
    resolveModelConfig({
      AI_PROVIDER: 'xai',
      OPENAI_API_KEY: 'sk-test',
      AURA_ROUTER_MODEL: 'off'
    }).routerModel,
    null
  );

  // Omitting effort defaults Grok to high — always send low/medium/high.
  assert.deepEqual(
    brainRequestOptions(withoutOpenAi, {
      messages: [],
      tools: [{ type: 'function', function: { name: 'lookup' } }]
    }),
    {
      messages: [],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      model: 'grok-4.5',
      reasoning_effort: 'low'
    }
  );
});

test('xAI reasoning_effort coerces none to low and honors medium/high', () => {
  assert.equal(resolveXaiReasoningEffort('none'), 'low');
  assert.equal(resolveXaiReasoningEffort('medium'), 'medium');
  assert.equal(resolveXaiReasoningEffort('high'), 'high');
  const medium = resolveModelConfig({
    AI_PROVIDER: 'xai',
    AURA_REASONING_EFFORT: 'medium'
  });
  assert.equal(
    brainRequestOptions(medium, { messages: [] }).reasoning_effort,
    'medium'
  );
  assert.deepEqual(
    brainRequestOptions(resolveModelConfig({ AI_PROVIDER: 'xai' }), {
      messages: [],
      _reasoningEffort: 'medium'
    }),
    {
      messages: [],
      model: 'grok-4.5',
      reasoning_effort: 'medium'
    }
  );
  assert.equal(
    Object.hasOwn(
      brainRequestOptions(resolveModelConfig({ AI_PROVIDER: 'xai' }), {
        messages: [],
        _reasoningEffort: 'medium'
      }),
      '_reasoningEffort'
    ),
    false
  );
});

test('medium reasoning keeps tool-routing on Luna and reserves primary for synthesis', () => {
  assert.equal(shouldUsePrimaryForRoundZero('medium', ['check_calendar']), false);
  assert.equal(shouldUsePrimaryForRoundZero('high', ['check_email', 'get_goals']), false);
  assert.equal(shouldUsePrimaryForRoundZero('medium', []), true);
  assert.equal(shouldUsePrimaryForRoundZero('low', []), false);
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

test('client matching accepts Whisper-garbled and partial last names', () => {
  // Spoken last-name misspellings against a stored "First Last".
  assert.ok(scoreClientName('pissavage', 'Jonathan Pesavage') >= 0.68);
  assert.ok(scoreClientName('jonathan pissavage', 'Jonathan Pesavage') >= 0.68);
  assert.ok(scoreClientName('carl elliot', 'Karl Elliott') >= 0.68);
  assert.ok(scoreClientName('Karl', 'Karl Elliott') >= 0.68);
  assert.ok(scoreClientName('Karl', 'Carl Elliott') >= 0.68);
  assert.ok(scoreClientName('Karl Elliott', 'Carl Elliott') >= 0.68);

  const pesavage = rankClientMatches('jonathan pissavage', [
    { id: 1, name: 'Jonathan Pesavage' },
    { id: 2, name: 'Jordan Smith' }
  ]);
  assert.deepEqual(pesavage.map(client => client.id), [1]);

  const karl = rankClientMatches('carl elliot', [
    { id: 1, name: 'Karl Elliott' },
    { id: 2, name: 'Carol Ellis' }
  ]);
  assert.deepEqual(karl.map(client => client.id), [1]);
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

test('near-miss suggestions surface close last names when the full score is low', () => {
  // Wrong first name + garbled last name averages below admit, but the
  // last-name token hit should still produce a "did you mean?" candidate.
  assert.ok(scoreClientName('mike pissavage', 'Jonathan Pesavage') < 0.68);
  const suggestions = suggestClientMatches('mike pissavage', [
    { id: 1, name: 'Jonathan Pesavage' },
    { id: 2, name: 'Taylor Jones' }
  ], { minScore: 0.45, limit: 3 });
  assert.ok(suggestions.length >= 1);
  assert.equal(suggestions[0].id, 1);
});

test('transcript correction rewrites clear Whisper mangling to directory names', () => {
  const clients = [
    { id: 1, name: 'Jonathan Pesavage' },
    { id: 2, name: 'Karl Elliott' },
    { id: 3, name: 'Jordan Smith' }
  ];
  assert.equal(
    correctTranscriptClientNames('What phase is jonathan pissavage in?', clients),
    'What phase is Jonathan Pesavage in?'
  );
  assert.equal(
    correctTranscriptClientNames('pull up carl elliot', clients),
    'pull up Karl Elliott'
  );
  assert.equal(
    correctTranscriptClientNames('Look up pissavage please', clients),
    'Look up Pesavage please'
  );
  // Ambiguous first name alone must not guess.
  assert.equal(
    correctTranscriptClientNames('How is Jordan doing?', [
      { id: 1, name: 'Jordan Smith' },
      { id: 2, name: 'Jordan Jones' }
    ]),
    'How is Jordan doing?'
  );
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

// Regression: correctTranscriptClientNames used to rewrite any 4+ letter word
// within one edit of a client name, so "call him back" became "call him Jack"
// and "I love you back" became "I love you Jack" - which the model then read
// as a statement about a personal relationship.
test('transcript correction leaves ordinary English alone', () => {
  const clients = [
    { id: 1, name: 'Jack Miller' },
    { id: 2, name: 'Mark Stein' },
    { id: 3, name: 'Dawn Reilly' },
    { id: 4, name: 'Grant Hughes' },
    { id: 5, name: 'Wade Harris' },
    { id: 6, name: 'Bill Turner' },
    { id: 7, name: 'Jack R. Privitello' }
  ];
  const untouched = [
    'call him back tomorrow',
    'I want my money back',
    'let me get back to you',
    'I love you back',
    'take the back way',
    'push it back a week',
    'park the car',
    'grant me access',
    'we made a deal',
    'at the dawn of the project',
    'mark it as done',
    'I will be right back',
    // The reported incident: talking about an ex, with a client named Jack in
    // the roster. "we got back together" became "we got Jack together", and
    // AURA concluded the owner was romantically involved with that client.
    'we got back together',
    'I want her back',
    'she never came back',
    'I never got her back'
  ];
  for (const phrase of untouched) {
    assert.equal(correctTranscriptClientNames(phrase, clients), phrase);
  }
});

test('client lookup refuses to resolve a common word to a client', () => {
  const clients = [{ id: 1, name: 'Jack Miller' }, { id: 2, name: 'Mark Stein' }];
  assert.deepEqual(rankClientMatches('back', clients), []);
  assert.deepEqual(rankClientMatches('mark', clients), []);
  // A real name still resolves.
  assert.equal(rankClientMatches('Jack Miller', clients).length, 1);
});

test('spoken affirmations resolve a pending preference confirmation', () => {
  const approvals = [
    'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'yes please', 'yes go ahead',
    'yes do it', 'sure thing', 'mhm', 'uh huh', 'of course', 'correct',
    'absolutely', 'please do', 'save that', 'sounds good', 'yes thanks'
  ];
  for (const reply of approvals) {
    assert.equal(classifyMemoryConfirmationReply(reply), 'approved', reply);
  }
  const rejections = [
    'no', 'nope', 'nah', 'not yet', 'skip it', 'forget it', 'never mind',
    'no thanks', 'please dont', 'not really', 'dont save that'
  ];
  for (const reply of rejections) {
    assert.equal(classifyMemoryConfirmationReply(reply), 'rejected', reply);
  }
  // A second clause means this is a request, not an answer.
  for (const reply of ['yes and email him about it', 'Do it', 'go ahead', 'remind me tomorrow']) {
    assert.equal(classifyMemoryConfirmationReply(reply), null, reply);
  }
});

test('pinned preferences are never crowded out by people entries', () => {
  const entries = {};
  for (let index = 0; index < 80; index += 1) {
    const key = `people.client${String(index).padStart(2, '0')}`;
    entries[key] = {
      key,
      kind: 'relationship',
      value: `Client ${index}`,
      subject: `Client ${index}`,
      relationship: 'client',
      pinned: true,
      updated_at: '2026-08-01T00:00:00Z'
    };
  }
  entries['preference.coffee'] = {
    key: 'preference.coffee',
    kind: 'preference',
    value: 'black coffee, no sugar',
    instruction: 'Assume black coffee.',
    subject: '',
    relationship: '',
    pinned: true,
    updated_at: '2026-08-19T00:00:00Z'
  };
  entries['pronunciation.pesavage'] = {
    key: 'pronunciation.pesavage',
    kind: 'pronunciation',
    value: 'Pesavage -> PESS-uh-vidge',
    instruction: 'Pronounce "Pesavage" as "PESS-uh-vidge".',
    subject: 'Pesavage',
    relationship: '',
    pinned: true,
    updated_at: '2026-08-19T00:00:00Z'
  };

  const selected = selectPinnedProfileEntries(Object.values(entries));
  const keys = selected.map(entry => entry.key);
  assert.equal(keys.includes('preference.coffee'), true);
  assert.equal(keys.includes('pronunciation.pesavage'), true);

  const context = buildProfileContext({ entries });
  assert.match(context, /black coffee/);
  assert.match(context, /PESS-uh-vidge/);
  // Clients are filed as business records, not as the owner's own relations.
  assert.match(context, /CCC BUSINESS CONTACTS/);
  const ownerSection = context.slice(
    context.indexOf('OWNER PROFILE FACTS'),
    context.indexOf('CCC BUSINESS CONTACTS')
  );
  assert.doesNotMatch(ownerSection, /Client \d/);
});

test('two different people sharing a name are not fused into one record', () => {
  const existing = {
    kind: 'relationship',
    key: 'people.sarah',
    subject: 'Sarah',
    relationship: 'wife',
    value: 'Sarah',
    emails: ['sarah@home.example'],
    organization: '',
    aliases: [],
    phones: [],
    preferences: [],
    commitments: []
  };
  const incoming = {
    kind: 'relationship',
    key: 'people.sarah',
    subject: 'Sarah',
    relationship: 'client',
    value: 'Sarah',
    emails: ['sarah@acme.example'],
    organization: 'Acme',
    aliases: [],
    phones: [],
    preferences: [],
    commitments: []
  };
  const merged = mergeRelationshipEntry(existing, incoming);
  // The client must not inherit the personal label or the personal address.
  assert.equal(merged.relationship, 'client');
  assert.equal(merged.emails.includes('sarah@home.example'), false);
});

test('a memory candidate is retired after the ask budget is spent', () => {
  const candidate = (id, askCount, updatedAt) => ({
    id,
    entry: {
      key: `preference.${id}`,
      kind: 'preference',
      value: `value ${id}`,
      subject: '',
      relationship: '',
      instruction: `Prefer ${id}.`,
      aliases: [],
      emails: [],
      phones: [],
      preferences: [],
      commitments: [],
      confidence: 0.7,
      source: 'conversation'
    },
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: updatedAt,
    ask_count: askCount,
    occurrences: 1
  });
  const profile = {
    memory_candidates: [
      candidate('exhausted-candidate', 2, '2026-08-19T00:00:00.000Z'),
      candidate('fresh-candidate', 0, '2026-08-18T00:00:00.000Z')
    ]
  };
  // The exhausted candidate is skipped even though it is the most recent, and
  // the older un-asked one is offered instead - previously the first element
  // in array order won and could block every candidate behind it.
  assert.equal(selectPendingConfirmation(profile).id, 'fresh-candidate');
  assert.equal(
    selectPendingConfirmation({
      memory_candidates: [candidate('spent-candidate', 2, '2026-08-19T00:00:00.000Z')]
    }),
    null
  );
});

// The owner's ex-girlfriend is also a CCC client. That is one person holding
// two true roles, not a data error - and an earlier version of this code
// treated the business/personal boundary as exclusive, which discarded her
// personal history every time the client record was re-extracted.
test('a person who is both a client and a personal relation keeps both roles', () => {
  const personal = {
    kind: 'relationship',
    key: 'people.melissa',
    subject: 'Melissa',
    value: 'Melissa',
    relationship: 'ex-girlfriend',
    roles: ['ex-girlfriend'],
    emails: ['melissa@personal.example'],
    aliases: ['Melissa D. Gordon'],
    phones: [],
    organization: '',
    role: '',
    preferences: [],
    commitments: [],
    last_context: 'AZCEND program'
  };
  const asClient = {
    kind: 'relationship',
    key: 'people.melissa',
    subject: 'Melissa D. Gordon',
    value: 'Melissa D. Gordon',
    relationship: 'client',
    roles: ['client'],
    emails: ['mgordon@work.example'],
    aliases: [],
    phones: [],
    organization: 'CCC',
    role: '',
    preferences: [],
    commitments: [],
    last_context: ''
  };

  const merged = mergeRelationshipEntry(personal, asClient);
  assert.deepEqual(merged.roles, ['ex-girlfriend', 'client']);
  // Neither address nor the personal history may be dropped.
  assert.equal(merged.emails.includes('melissa@personal.example'), true);
  assert.equal(merged.emails.includes('mgordon@work.example'), true);
  assert.equal(merged.last_context, 'AZCEND program');

  // Anyone holding a personal role belongs with the owner's own people, so the
  // business block's framing is never applied to them.
  const context = buildProfileContext({ entries: { 'people.melissa': { ...merged, pinned: true } } });
  assert.match(context, /OWNER PROFILE FACTS/);
  assert.match(context, /roles=ex-girlfriend, client/);
  assert.doesNotMatch(context, /CCC BUSINESS CONTACTS/);

  // A client with no personal role still files as a business record.
  const pureClient = {
    ...asClient,
    subject: 'Jack R. Privitello',
    value: 'Jack R. Privitello',
    aliases: [],
    pinned: true
  };
  const clientContext = buildProfileContext({ entries: { 'people.jack': pureClient } });
  assert.match(clientContext, /CCC BUSINESS CONTACTS/);
  assert.doesNotMatch(clientContext, /OWNER PROFILE FACTS/);
});

test('the business-contacts block never denies a stated personal role', () => {
  const context = buildProfileContext({
    entries: {
      'people.jack': {
        kind: 'relationship',
        key: 'people.jack',
        subject: 'Jack R. Privitello',
        value: 'Jack R. Privitello',
        relationship: 'client',
        roles: ['client'],
        aliases: [], emails: [], phones: [], preferences: [], commitments: [],
        organization: 'CCC', role: '', last_context: '',
        pinned: true
      }
    }
  });
  // The old wording asserted these people are never personal relations, which
  // is false for anyone who is both - and would have AURA deny something true.
  assert.doesNotMatch(context, /Never describe these people as the owner's/);
  assert.match(context, /may legitimately hold more than one role/);
  assert.match(context, /never deny it if he asks directly/);
});

test('a dual-role contact gets an explicit business-privacy instruction', () => {
  const entries = {
    'people.melissa': {
      key: 'people.melissa',
      kind: 'relationship',
      subject: 'Melissa D. Gordon',
      value: 'Melissa',
      relationship: 'client',
      roles: ['ex-girlfriend', 'client'],
      organization: 'CCC',
      last_context: 'AZCEND program',
      aliases: [], emails: [], phones: [], preferences: [], commitments: [], role: '',
      pinned: true
    }
  };
  const context = buildProfileContext({ entries });
  // Stays in owner context so nothing can deny the personal tie...
  assert.match(context, /OWNER PROFILE FACTS/);
  // ...but the business discretion rule now reaches her, which it did not when
  // it lived only in the CCC block she is deliberately not filed under.
  assert.match(context, /DUAL-ROLE CONTACTS/);
  assert.match(context, /business role client; personal role ex-girlfriend/);
  assert.match(context, /leave their personal history out of the reply/);
  assert.match(context, /never deny it/);

  // A purely personal contact gets no such block.
  const personalOnly = buildProfileContext({
    entries: {
      'people.taylor': {
        ...entries['people.melissa'],
        key: 'people.taylor', subject: 'Taylor', relationship: 'daughter',
        roles: ['daughter'], organization: '', last_context: ''
      }
    }
  });
  assert.doesNotMatch(personalOnly, /DUAL-ROLE CONTACTS/);
});

test('two people sharing only a generic label are never merged', () => {
  const client = (subject, email) => ({
    kind: 'relationship', key: 'people.chris', subject, value: subject,
    relationship: 'client', roles: ['client'], emails: [email],
    aliases: [], phones: [], preferences: [], commitments: [],
    organization: '', role: '', last_context: ''
  });
  // Both are "client"; that shared label must not count as identity evidence.
  const merged = mergeRelationshipEntry(client('Chris', 'a@example.com'), client('Chris', 'b@example.com'));
  assert.deepEqual(merged.emails, ['b@example.com']);

  // Same for two daughters - a shared personal label is no better as proof.
  const daughter = (subject) => ({ ...client(subject, `${subject}@example.com`), relationship: 'daughter', roles: ['daughter'] });
  const kids = mergeRelationshipEntry(daughter('Taylor'), daughter('Madison'));
  assert.equal(kids.emails.includes('Taylor@example.com'), false);
});

test('an asked candidate survives long enough to be answered', async () => {
  const profileStore = createProfileStore();
  const semanticMemory = createSemanticMemory();
  const client = extractionClient([{
    key: 'preference.spark', kind: 'preference', value: 'daily sparks',
    subject: '', relationship: '', instruction: 'Send a daily spark.',
    replaces_key: '', pinned: true, confidence: 0.7
  }]);
  const memory = new MemoryV2({ profileStore, semanticMemory, client });
  await memory.learnFromUserMessage('I like daily sparks.', { source: 'conversation' });

  const first = await memory.getPendingConfirmation();
  await memory.markConfirmationAsked(first.id, { entryKey: first.entry.key });
  await memory.markConfirmationAsked(first.id, { entryKey: first.entry.key });

  // The budget stops her ASKING again...
  assert.equal(await memory.getPendingConfirmation(), null);
  // ...but the candidate itself must still be resolvable, or the "yes" the
  // owner is about to give for the question he just heard resolves nothing.
  const resolution = await memory.resolvePendingConfirmation(first.id, true, { entryKey: first.entry.key });
  assert.equal(resolution.resolved, true);
  assert.equal(resolution.learned.length, 1);
});
