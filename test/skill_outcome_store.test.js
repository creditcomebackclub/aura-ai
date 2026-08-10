'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SkillOutcomeStore,
  classifyOwnerFeedback,
  outcomeStatus,
  skillUsagesFromEvidence
} = require('../skill_outcome_store');

function createStateStore() {
  const rows = new Map();
  let revision = 0;
  return {
    rows,
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

test('owner feedback classifier is conservative and correction-aware', () => {
  assert.equal(classifyOwnerFeedback("That's wrong—the balance is 50."), 'negative');
  assert.equal(classifyOwnerFeedback('Correction: I meant next Tuesday.'), 'negative');
  assert.equal(classifyOwnerFeedback('Perfect, that worked.'), 'positive');
  assert.equal(classifyOwnerFeedback('Thanks for checking.'), null);
  assert.equal(classifyOwnerFeedback('No meetings are scheduled today.'), null);
});

test('skill evidence attributes exact versions and summarizes tool outcomes', () => {
  const evidence = [
    { tool: 'view_skill', ok: true, skill: { name: 'client-sweep', origin: 'learned', version: 3 } },
    { tool: 'get_client_snapshot', ok: true },
    { tool: 'check_email', ok: false }
  ];
  assert.deepEqual(skillUsagesFromEvidence(evidence), [{
    name: 'client-sweep', origin: 'learned', version: 3
  }]);
  assert.deepEqual(outcomeStatus(evidence), { status: 'partial', successes: 1, failures: 1 });
});

test('skill outcome ledger records use and links the next owner correction', async () => {
  const stateStore = createStateStore();
  const store = new SkillOutcomeStore({ stateStore });
  const [created] = await store.recordTurn({
    ownerText: 'Run the client sweep.',
    reply: 'I found one stalled client.',
    messageId: 42,
    evidence: [
      { tool: 'view_skill', ok: true, skill: { name: 'client-sweep', origin: 'learned', version: 2 } },
      { tool: 'get_client_snapshot', ok: true }
    ]
  });
  assert.equal(created.skill_version, 2);
  assert.equal(created.status, 'succeeded');
  assert.equal(created.assistant_message_id, 42);

  const corrected = await store.applyOwnerFeedback("That's wrong—the client is active.");
  assert.equal(corrected.id, created.id);
  assert.equal(corrected.feedback, 'negative');
  assert.equal(corrected.feedback_source, 'next_owner_turn');
  assert.equal((await store.summary()).negative_feedback, 1);
});

test('explicit feedback overrides automatic feedback and secret excerpts are omitted', async () => {
  const store = new SkillOutcomeStore({ stateStore: createStateStore() });
  const [created] = await store.recordTurn({
    ownerText: 'My API key is sk-abcdefghijklmnopqrstuvwxyz123456.',
    reply: 'Handled without repeating it.',
    evidence: [
      { tool: 'view_skill', ok: true, skill: { name: 'safe-run', origin: 'bundled', version: 1 } }
    ]
  });
  assert.equal(created.owner_request, '');
  await store.applyOwnerFeedback("That's wrong.");
  const updated = await store.setFeedback(created.id, {
    rating: 'positive',
    note: 'Retested manually and it worked.'
  });
  assert.equal(updated.feedback, 'positive');
  assert.equal(updated.feedback_source, 'explicit_owner_feedback');
  assert.match(updated.feedback_text, /Retested manually/);
});

test('a neutral next turn closes automatic attribution without false feedback', async () => {
  const store = new SkillOutcomeStore({ stateStore: createStateStore() });
  const [created] = await store.recordTurn({
    ownerText: 'Run it.',
    reply: 'Done.',
    evidence: [
      { tool: 'view_skill', ok: true, skill: { name: 'demo', origin: 'learned', version: 1 } }
    ]
  });
  const observed = await store.applyOwnerFeedback('What is on my calendar tomorrow?');
  assert.equal(observed.id, created.id);
  assert.equal(observed.feedback, 'none');
  assert.equal(observed.feedback_text, '');
  assert.equal(await store.applyOwnerFeedback("That's wrong."), null);
});

test('next-turn feedback applies to every skill used in the same response', async () => {
  const store = new SkillOutcomeStore({ stateStore: createStateStore() });
  const created = await store.recordTurn({
    ownerText: 'Run both.',
    reply: 'Done.',
    messageId: 77,
    evidence: [
      { tool: 'view_skill', ok: true, skill: { name: 'one', origin: 'learned', version: 1 } },
      { tool: 'view_skill', ok: true, skill: { name: 'two', origin: 'learned', version: 4 } }
    ]
  });
  assert.equal(created.length, 2);
  await store.applyOwnerFeedback('Incorrect, that was not what I asked for.');
  const outcomes = await store.list();
  assert.equal(outcomes.filter(item => item.feedback === 'negative').length, 2);
});
