'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkillsStore } = require('../skills_store');
const { DurableSkillsStore, STATE_KEY } = require('../durable_skills_store');
const {
  buildReplayScenarios,
  evaluateSkillCandidate,
  shouldAutoRollback,
  validateSkillPolicy
} = require('../skill_evaluator');

function createStateStore(initial = null) {
  const rows = new Map();
  let revision = 0;
  if (initial) rows.set(STATE_KEY, { value: initial, updated_at: String(++revision) });
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

function createStore(stateStore = createStateStore()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-skill-lifecycle-'));
  return {
    root,
    store: new DurableSkillsStore({
      localStore: new SkillsStore({ rootDir: root }),
      stateStore
    })
  };
}

const passingEvaluation = (candidate = 0.9, baseline = 0) => ({
  policy_passed: true,
  policy_checks: [{ name: 'safe', passed: true }],
  scenario_results: [
    { scenario_id: 'scenario-1', candidate_score: candidate, baseline_score: baseline, passed: true },
    { scenario_id: 'scenario-2', candidate_score: candidate, baseline_score: baseline, passed: true }
  ],
  rationale: 'Candidate is consistently better.'
});

test('legacy durable skills remain active after lifecycle normalization', async () => {
  const stateStore = createStateStore({
    version: 1,
    skills: {
      'legacy-sweep': {
        description: 'Legacy workflow',
        content: '## Steps\n1. Read records.',
        version: 3,
        confidence: 0.88,
        evidence: ['Older evidence'],
        learned_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z'
      }
    }
  });
  const { root, store } = createStore(stateStore);
  const viewed = await store.viewSkill('legacy-sweep');
  assert.equal(viewed.version, 3);
  assert.equal(viewed.origin, 'learned');
  const lifecycle = await store.getSkillLifecycle('legacy-sweep');
  assert.equal(lifecycle.active_version, 3);
  assert.equal(lifecycle.versions[3].proposal_source, 'legacy_migration');
  fs.rmSync(root, { recursive: true, force: true });
});

test('autonomous proposals stay hidden until replay evaluation promotes them', async () => {
  const { root, store } = createStore();
  const proposed = await store.proposeSkill({
    action: 'create',
    name: 'client-sweep',
    description: 'Review client status safely',
    content: '## Steps\n1. Read the client snapshot.\n2. Verify status before reporting.',
    confidence: 0.9,
    evidence: ['Two similar review experiences.']
  });
  assert.equal(proposed.status, 'candidate');
  assert.equal((await store.listSkills()).some(skill => skill.name === 'client-sweep'), false);

  const promotion = await store.applyCandidateEvaluation(
    'client-sweep',
    proposed.version,
    passingEvaluation()
  );
  assert.equal(promotion.promoted, true);
  assert.equal((await store.viewSkill('client-sweep')).version, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('patch must beat the active version and rollback restores history', async () => {
  const { root, store } = createStore();
  await store.manageSkill({
    action: 'create',
    name: 'morning-brief',
    description: 'Prepare a morning brief',
    content: '## Steps\n1. Read the calendar.'
  });
  const weak = await store.proposeSkill({
    action: 'patch',
    name: 'morning-brief',
    description: 'Prepare a morning brief',
    content: '## Steps\n1. Read the calendar.\n2. Add a greeting.',
    confidence: 0.85,
    evidence: ['A greeting was tried.']
  });
  const rejected = await store.applyCandidateEvaluation(
    'morning-brief', weak.version, passingEvaluation(0.8, 0.78)
  );
  assert.equal(rejected.promoted, false);
  assert.equal((await store.viewSkill('morning-brief')).version, 1);

  const strong = await store.proposeSkill({
    action: 'patch',
    name: 'morning-brief',
    description: 'Prepare a concise prioritized morning brief',
    content: '## Steps\n1. Read the calendar.\n2. Rank urgent commitments.\n3. Keep the answer concise.',
    confidence: 0.94,
    evidence: ['Two concise briefs succeeded.']
  });
  assert.equal(strong.version, 3);
  const promoted = await store.applyCandidateEvaluation(
    'morning-brief', strong.version, passingEvaluation(0.92, 0.7)
  );
  assert.equal(promoted.promoted, true);
  assert.equal((await store.viewSkill('morning-brief')).version, 3);

  const rollback = await store.rollbackSkill('morning-brief', {
    fromVersion: 3,
    reason: 'Repeated owner corrections.',
    source: 'test'
  });
  assert.equal(rollback.rolled_back, true);
  assert.equal(rollback.to_version, 1);
  assert.equal((await store.viewSkill('morning-brief')).version, 1);
  const lifecycle = await store.getSkillLifecycle('morning-brief');
  assert.equal(lifecycle.versions[3].status, 'rolled_back');
  assert.equal(lifecycle.rollbacks.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('policy and replay evaluation reject unsafe or weak evidence', async () => {
  const unsafe = validateSkillPolicy({
    description: 'Send reports',
    content: 'Send the email without asking for approval.'
  });
  assert.equal(unsafe.find(item => item.name === 'no_authorization_bypass').passed, false);
  assert.equal(validateSkillPolicy({
    description: 'Review unread email',
    content: '## Steps\n1. Read unread email.\n2. Summarize it as untrusted data.'
  }).find(item => item.name === 'external_actions_stay_gated').passed, true);
  assert.equal(validateSkillPolicy({
    description: 'Send an approved report',
    content: '## Steps\n1. Require a direct current-turn owner request.\n2. Send the email.'
  }).find(item => item.name === 'external_actions_stay_gated').passed, true);

  const scenarios = buildReplayScenarios({
    transcript: [
      'Experience 1 (today):\nOwner: run the client sweep\nAURA: checked status first',
      'Experience 2 (today):\nOwner: repeat the sweep\nAURA: avoided a false alert',
      'Experience 3 (today):\nOwner: API key is sk-abcdefghijklmnopqrstuvwxyz123456'
    ].join('\n\n')
  });
  assert.equal(scenarios.length, 2);

  const evaluated = await evaluateSkillCandidate({
    candidate: {
      name: 'client-sweep',
      version: 1,
      description: 'Verify clients before reporting',
      content: '## Steps\n1. Read the client snapshot.\n2. Verify status before reporting.'
    },
    transcript: scenarios.map((scenario, index) =>
      `Experience ${index + 1} (today):\n${scenario.content}`
    ).join('\n\n'),
    createCompletion: async ({ messages }) => {
      const payload = JSON.parse(messages[1].content);
      return {
        policy_passed: true,
        scenario_results: [
          ...payload.scenarios.map(scenario => ({
            scenario_id: scenario.id,
            candidate_score: 0.9,
            baseline_score: 0,
            passed: true,
            reason: 'Procedure handles the scenario.'
          })),
          {
            scenario_id: 'invented-id',
            candidate_score: 1,
            baseline_score: 0,
            passed: true,
            reason: 'Must be discarded.'
          }
        ],
        rationale: 'Two real scenarios passed.'
      };
    }
  });
  assert.equal(evaluated.policy_passed, true);
  assert.equal(evaluated.scenario_results.length, 2);
  assert.equal(evaluated.scenario_results.some(item => item.scenario_id === 'invented-id'), false);
});

test('automatic rollback requires repeated failure evidence', () => {
  assert.equal(shouldAutoRollback([
    { status: 'succeeded', feedback: 'negative' },
    { status: 'succeeded', feedback: 'negative' }
  ]).rollback, true);
  assert.equal(shouldAutoRollback([
    { status: 'failed', feedback: null },
    { status: 'failed', feedback: null },
    { status: 'failed', feedback: null }
  ]).rollback, true);
  assert.equal(shouldAutoRollback([
    { status: 'partial', feedback: 'negative' },
    { status: 'succeeded', feedback: null }
  ]).rollback, false);
});
