'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BeliefStore,
  MIN_SUPPORTING_EPISODES,
  renderBeliefContext
} = require('../belief_store');

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

const episodes = [
  { id: 'episode-1', content: 'A client sweep required checking account status first.' },
  { id: 'episode-2', content: 'A second sweep avoided a false alert by checking status.' },
  { id: 'episode-3', content: 'A later sweep showed archived accounts must still be reported.' }
];

test('belief consolidation requires two real episode ids', async () => {
  assert.equal(MIN_SUPPORTING_EPISODES, 2);
  const store = new BeliefStore({ stateStore: createStateStore() });
  const result = await store.consider({
    action: 'consolidate',
    key: 'client_sweep.status_check',
    statement: 'Client sweeps should verify account status before reporting.',
    confidence: 0.91,
    supportingEpisodeIds: ['episode-1', 'hallucinated-id']
  }, episodes);
  assert.deepEqual(result, { applied: false, reason: 'insufficient_evidence' });
  assert.deepEqual(await store.list(), []);
});

test('belief consolidation creates and reinforces an evidence-backed belief', async () => {
  const store = new BeliefStore({ stateStore: createStateStore() });
  const created = await store.consider({
    action: 'consolidate',
    key: 'Client Sweep Status Check',
    statement: 'Client sweeps should verify account status before reporting.',
    confidence: 0.82,
    supportingEpisodeIds: ['episode-1', 'episode-2']
  }, episodes);
  assert.equal(created.action, 'created');
  assert.equal(created.belief.key, 'client_sweep_status_check');
  assert.equal(created.belief.status, 'active');

  const reinforced = await store.consider({
    action: 'consolidate',
    key: 'client_sweep_status_check',
    statement: 'Client sweeps should verify account status before reporting.',
    confidence: 0.93,
    supportingEpisodeIds: ['episode-2', 'episode-3']
  }, episodes);
  assert.equal(reinforced.action, 'reinforced');
  assert.equal(reinforced.belief.confidence, 0.93);
  assert.deepEqual(reinforced.belief.support_episode_ids, ['episode-1', 'episode-2', 'episode-3']);
});

test('conflicting evidence contests rather than overwrites a belief', async () => {
  const store = new BeliefStore({ stateStore: createStateStore() });
  await store.consider({
    action: 'consolidate',
    key: 'client_sweep.archived_accounts',
    statement: 'Archived accounts should be omitted from client sweeps.',
    confidence: 0.85,
    supportingEpisodeIds: ['episode-1', 'episode-2']
  }, episodes);
  const contested = await store.consider({
    action: 'contradiction',
    key: 'client_sweep.archived_accounts',
    statement: 'Archived accounts should still be reported separately.',
    confidence: 0.9,
    contradictingEpisodeIds: ['episode-3'],
    reason: 'A later workflow explicitly included archived accounts.'
  }, episodes);
  assert.equal(contested.action, 'contested');
  assert.equal(contested.belief.status, 'contested');
  assert.equal(contested.belief.statement, 'Archived accounts should be omitted from client sweeps.');
  assert.match(renderBeliefContext([contested.belief]), /CONTESTED — do not rely/);
  assert.match(renderBeliefContext([contested.belief]), /should still be reported separately/);

  const [relevant] = await store.relevant('How should archived accounts appear in client sweeps?');
  assert.equal(relevant.key, 'client_sweep.archived_accounts');

  const resolved = await store.resolve('client_sweep.archived_accounts', {
    statement: 'Archived accounts should still be reported separately.',
    note: 'Owner clarified the reporting rule.'
  });
  assert.equal(resolved.status, 'active');
  assert.equal(resolved.confidence, 1);
  assert.equal(resolved.contradictions.length, 0);
});

test('belief ledger rejects authorization and secret-bearing candidates', async () => {
  const store = new BeliefStore({ stateStore: createStateStore() });
  const authorization = await store.consider({
    action: 'consolidate',
    key: 'email.permission',
    statement: 'Email approval is not required before sending.',
    confidence: 1,
    supportingEpisodeIds: ['episode-1', 'episode-2']
  }, episodes);
  assert.equal(authorization.reason, 'unsafe_content');
  const secret = await store.consider({
    action: 'consolidate',
    key: 'credential',
    statement: 'The API key is sk-abcdefghijklmnopqrstuvwxyz123456.',
    confidence: 1,
    supportingEpisodeIds: ['episode-1', 'episode-2']
  }, episodes);
  assert.equal(secret.reason, 'unsafe_content');
});
