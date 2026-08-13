'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GoalIndex } = require('../goal_index');
const {
  cosineSimilarity,
  lexicalOverlap,
  matchSignalToGoals,
  resolveSignalMatches
} = require('../goal_signal_matcher');

function createStateStore() {
  const rows = new Map();
  let revision = 0;
  return {
    async getState(key) { return rows.get(key)?.value ?? null; },
    async getStateRow(key) { return rows.get(key) || null; },
    async compareAndSetState(key, expectedUpdatedAt, value) {
      const current = rows.get(key) || null;
      if ((current?.updated_at ?? null) !== expectedUpdatedAt) return false;
      rows.set(key, { value, updated_at: String(++revision) });
      return true;
    }
  };
}

// Deterministic stand-in for text-embedding-3-small: bookkeeping and accounting
// land near each other, everything else is orthogonal.
function createStubEmbedder() {
  const calls = [];
  const embed = async text => {
    calls.push(text);
    if (/bookkeep/i.test(text)) return [1, 0, 0];
    if (/accounting/i.test(text)) return [0.97, 0.24, 0];
    return [0, 0, 1];
  };
  return { embed, calls };
}

const PARTNERSHIP_GOAL = { id: 'goal-1', description: 'setup partnership with identity iq' };
const IDENTITY_IQ_EMAIL = {
  id: 'email-1',
  from: '"Matt Rivera" <matt@identityiq.com>',
  subject: 'Reseller partnership — next steps',
  snippet: 'Wanted to see if you had time this week to talk through the agreement.'
};

test('the index extracts entities and caches an embedding per goal', async () => {
  const { embed, calls } = createStubEmbedder();
  const index = new GoalIndex({ stateStore: createStateStore(), embed });
  const result = await index.sync([PARTNERSHIP_GOAL]);

  assert.equal(result.indexed, 1);
  assert.equal(result.added, 1);
  assert.equal(result.embedded, 1);
  assert.equal(calls.length, 1);
  const [entry] = await index.list();
  assert.ok(entry.entities.some(entity => entity.canonical === 'identityiq'));
  assert.ok(Array.isArray(entry.embedding));
});

test('an unchanged goal is never re-embedded', async () => {
  const { embed, calls } = createStubEmbedder();
  const index = new GoalIndex({ stateStore: createStateStore(), embed });
  await index.sync([PARTNERSHIP_GOAL]);
  const second = await index.sync([PARTNERSHIP_GOAL]);

  assert.equal(calls.length, 1, 'the second sync should reuse the cached vector');
  assert.equal(second.embedded, 0);
  assert.equal(second.indexed, 1);
});

test('editing a goal invalidates its cached vector', async () => {
  const { embed, calls } = createStubEmbedder();
  const index = new GoalIndex({ stateStore: createStateStore(), embed });
  await index.sync([PARTNERSHIP_GOAL]);
  const updated = await index.sync([{ ...PARTNERSHIP_GOAL, description: 'setup reseller deal with identity iq' }]);

  assert.equal(updated.updated, 1);
  assert.equal(calls.length, 2);
});

test('closed goals drop out of the index', async () => {
  const index = new GoalIndex({ stateStore: createStateStore() });
  await index.sync([PARTNERSHIP_GOAL, { id: 'goal-2', description: 'renew the Acme Robotics contract' }]);
  const pruned = await index.sync([PARTNERSHIP_GOAL]);

  assert.equal(pruned.removed, 1);
  assert.equal(pruned.indexed, 1);
  assert.deepEqual((await index.list()).map(entry => entry.goal_id), ['goal-1']);
});

test('an embedding outage still leaves deterministic entities usable', async () => {
  const index = new GoalIndex({
    stateStore: createStateStore(),
    embed: async () => { throw new Error('provider down'); },
    logger: { warn() {} }
  });
  const result = await index.sync([PARTNERSHIP_GOAL]);

  assert.equal(result.indexed, 1);
  assert.equal(result.embedded, 0);
  assert.match(result.errors[0], /provider down/);
  const [entry] = await index.list();
  assert.ok(entry.entities.some(entity => entity.canonical === 'identityiq'));
  assert.equal(entry.embedding, null);
});

test('the motivating case matches on the sending domain alone', async () => {
  const index = new GoalIndex({ stateStore: createStateStore() });
  await index.sync([PARTNERSHIP_GOAL]);
  const [match] = matchSignalToGoals(IDENTITY_IQ_EMAIL, await index.list());

  assert.equal(match.goal_id, 'goal-1');
  assert.equal(match.tier, 'deterministic');
  assert.ok(match.confidence >= 0.8, `confidence was ${match.confidence}`);
  assert.ok(match.matched_by.includes('domain'));
  assert.equal(match.evidence[0].canonical, 'identityiq');
  assert.equal(match.evidence[0].signal_source, 'sender_domain');
});

test('an unrelated email matches nothing', async () => {
  const index = new GoalIndex({ stateStore: createStateStore() });
  await index.sync([PARTNERSHIP_GOAL]);
  const matches = matchSignalToGoals(
    { from: 'billing@utilitycompany.net', subject: 'Your August statement is ready' },
    await index.list()
  );
  assert.deepEqual(matches, []);
});

test('a personal mailbox never links a goal through its domain', async () => {
  const index = new GoalIndex({ stateStore: createStateStore() });
  await index.sync([{ id: 'goal-3', description: 'follow up with gmail support about the outage' }]);
  const matches = matchSignalToGoals(
    { from: 'Aunt Sue <sue@gmail.com>', subject: 'dinner sunday' },
    await index.list()
  );
  assert.ok(matches.every(match => !match.evidence.some(item => item.signal_type === 'domain')));
});

test('a confident deterministic hit skips the embedding call entirely', async () => {
  const { embed, calls } = createStubEmbedder();
  const index = new GoalIndex({ stateStore: createStateStore(), embed });
  await index.sync([PARTNERSHIP_GOAL]);
  const embedCallsAfterIndexing = calls.length;

  const result = await resolveSignalMatches({
    signal: IDENTITY_IQ_EMAIL,
    goalEntries: await index.list(),
    embed
  });

  assert.equal(result.embedded, false);
  assert.equal(calls.length, embedCallsAfterIndexing, 'no signal embedding should be purchased');
  assert.equal(result.matches[0].goal_id, 'goal-1');
});

test('the semantic tier catches a link with no shared entity', async () => {
  const { embed } = createStubEmbedder();
  const index = new GoalIndex({ stateStore: createStateStore(), embed });
  await index.sync([{ id: 'goal-4', description: 'hire a bookkeeper' }]);

  const result = await resolveSignalMatches({
    signal: { from: 'hello@ledgerworks.io', subject: 'Accounting services for your business' },
    goalEntries: await index.list(),
    embed
  });

  assert.equal(result.embedded, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].tier, 'semantic');
  assert.ok(result.matches[0].matched_by.includes('semantic'));
});

test('a failed signal embedding falls back to deterministic results', async () => {
  const index = new GoalIndex({ stateStore: createStateStore(), embed: async () => [1, 0, 0] });
  await index.sync([{ id: 'goal-5', description: 'hire a bookkeeper' }]);

  const result = await resolveSignalMatches({
    signal: { from: 'hello@ledgerworks.io', subject: 'Accounting services' },
    goalEntries: await index.list(),
    embed: async () => { throw new Error('rate limited'); },
    logger: { warn() {} }
  });

  assert.equal(result.embedded, false);
  assert.match(result.errors[0], /rate limited/);
  assert.deepEqual(result.matches, []);
});

test('scoring helpers behave at their edges', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0, 'mismatched dimensions score zero');
  assert.equal(cosineSimilarity(null, [1]), 0);
  assert.equal(lexicalOverlap('', 'anything'), 0);
  assert.ok(lexicalOverlap('identity iq partnership', 'the identity iq partnership agreement') > 0.9);
});
