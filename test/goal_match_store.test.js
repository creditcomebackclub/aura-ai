'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BASE_THRESHOLD,
  GoalMatchStore,
  IGNORED_AFTER_MS,
  MAX_THRESHOLD,
  MIN_OBSERVATIONS,
  MIN_THRESHOLD,
  matchClass,
  resolveOutcome,
  thresholdFromCounts
} = require('../goal_match_store');

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

function domainMatch(overrides = {}) {
  return {
    goal_id: 'goal-1',
    goal_text: 'setup partnership with identity iq',
    confidence: 0.88,
    tier: 'deterministic',
    matched_by: ['domain'],
    evidence: [{ canonical: 'identityiq', signal_type: 'domain', signal_source: 'sender_domain', weight: 0.88 }],
    scores: { deterministic: 0.88, semantic: 0.2 },
    ...overrides
  };
}

async function seed(store, count, { rating, klass = 'domain' }) {
  for (let index = 0; index < count; index += 1) {
    const record = await store.record({
      match: domainMatch({
        evidence: [{ canonical: 'x', signal_type: klass, signal_source: 'sender_domain', weight: 0.9 }],
        tier: klass === 'semantic' ? 'semantic' : 'deterministic'
      }),
      signal: { id: `signal-${klass}-${index}`, from: 'matt@identityiq.com', subject: 'Hello' }
    });
    await store.setFeedback(record.id, { rating });
  }
}

test('match class comes from the tier, then the strongest evidence', () => {
  assert.equal(matchClass(domainMatch()), 'domain');
  assert.equal(matchClass({ tier: 'semantic', evidence: [] }), 'semantic');
  assert.equal(matchClass({ tier: 'deterministic', evidence: [{ signal_type: 'person' }] }), 'person');
  assert.equal(matchClass({}), 'phrase');
});

test('a class keeps the base threshold until it has enough observations', () => {
  const thin = thresholdFromCounts({ positives: MIN_OBSERVATIONS - 1, negatives: 0 });
  assert.equal(thin.threshold, BASE_THRESHOLD);
  assert.equal(thin.adapted, false);
});

test('acted-on classes get a lower bar and ignored classes a higher one', () => {
  const trusted = thresholdFromCounts({ positives: 10, negatives: 0 });
  const noisy = thresholdFromCounts({ positives: 0, negatives: 10 });
  assert.ok(trusted.threshold < BASE_THRESHOLD, `expected < ${BASE_THRESHOLD}, got ${trusted.threshold}`);
  assert.ok(noisy.threshold > BASE_THRESHOLD, `expected > ${BASE_THRESHOLD}, got ${noisy.threshold}`);
  assert.ok(trusted.threshold >= MIN_THRESHOLD);
  assert.ok(noisy.threshold <= MAX_THRESHOLD);
});

test('thresholds stay clamped no matter how lopsided the history', () => {
  assert.equal(thresholdFromCounts({ positives: 500, negatives: 0 }).threshold, MIN_THRESHOLD);
  assert.equal(thresholdFromCounts({ positives: 0, negatives: 500 }).threshold, MAX_THRESHOLD);
});

test('a recorded match carries its full score breakdown', async () => {
  const store = new GoalMatchStore({ stateStore: createStateStore() });
  const record = await store.record({
    match: domainMatch(),
    signal: { id: 'email-1', from: '"Matt Rivera" <matt@identityiq.com>', subject: 'Partnership' },
    suggestedWindows: [{ start: 'a', end: 'b', minutes: 120, label: 'Thursday, Aug 20 3–5 PM' }],
    notificationId: 42
  });

  assert.equal(record.match_class, 'domain');
  assert.equal(record.goal_id, 'goal-1');
  assert.equal(record.suggested_windows[0].label, 'Thursday, Aug 20 3–5 PM');
  assert.equal(record.notification_id, '42');
  assert.equal(record.evidence[0].canonical, 'identityiq');
  assert.equal(record.outcome, null);
});

test('the same signal never records the same goal twice', async () => {
  const store = new GoalMatchStore({ stateStore: createStateStore() });
  const first = await store.record({ match: domainMatch(), signal: { id: 'email-1' } });
  const second = await store.record({ match: domainMatch(), signal: { id: 'email-1' } });

  assert.ok(first);
  assert.equal(second, null);
  assert.equal((await store.list()).length, 1);
});

test('credentials never reach the ledger', async () => {
  const store = new GoalMatchStore({ stateStore: createStateStore() });
  const record = await store.record({
    match: domainMatch(),
    signal: { id: 'email-2', from: 'noreply@bank.com', subject: 'Your one-time code is 448120' }
  });
  assert.equal(record.signal_subject, '');
});

test('repeated positive feedback lowers that class threshold only', async () => {
  const store = new GoalMatchStore({ stateStore: createStateStore() });
  await seed(store, 6, { rating: 'positive', klass: 'domain' });
  const thresholds = await store.thresholds();

  assert.ok(thresholds.domain.threshold < BASE_THRESHOLD);
  assert.equal(thresholds.domain.adapted, true);
  assert.equal(thresholds.phrase.threshold, BASE_THRESHOLD, 'an unobserved class must not move');
});

test('repeated negative feedback raises that class threshold', async () => {
  const store = new GoalMatchStore({ stateStore: createStateStore() });
  await seed(store, 6, { rating: 'negative', klass: 'phrase' });
  const thresholds = await store.thresholds();

  assert.ok(thresholds.phrase.threshold > BASE_THRESHOLD);
  assert.equal(thresholds.domain.threshold, BASE_THRESHOLD);
});

test('filtering holds each match to its own class threshold', async () => {
  const store = new GoalMatchStore({ stateStore: createStateStore() });
  await seed(store, 6, { rating: 'negative', klass: 'phrase' });

  const phraseMatch = {
    ...domainMatch({ confidence: 0.62 }),
    evidence: [{ canonical: 'x', signal_type: 'phrase', weight: 0.62 }]
  };
  const domainOnly = domainMatch({ confidence: 0.62 });

  const kept = await store.filterByThreshold([phraseMatch, domainOnly]);
  assert.equal(kept.length, 1, 'the noisy phrase class should be filtered out');
  assert.equal(matchClass(kept[0]), 'domain');
});

test('the permissive matcher threshold is the minimum across classes', async () => {
  const store = new GoalMatchStore({ stateStore: createStateStore() });
  await seed(store, 6, { rating: 'positive', klass: 'domain' });
  const thresholds = await store.thresholds();

  assert.equal(await store.minThreshold(), thresholds.domain.threshold);
});

test('an unacknowledged match ages into a soft negative', () => {
  const fresh = { created_at: new Date().toISOString(), outcome: null, feedback: null };
  const stale = { created_at: new Date(Date.now() - IGNORED_AFTER_MS - 1000).toISOString(), outcome: null, feedback: null };

  assert.equal(resolveOutcome(fresh), null);
  assert.equal(resolveOutcome(stale), 'negative');
  assert.equal(resolveOutcome({ ...stale, outcome: 'acted' }), 'positive');
});

test('acting on a match counts as positive without explicit feedback', async () => {
  const store = new GoalMatchStore({ stateStore: createStateStore() });
  const record = await store.record({ match: domainMatch(), signal: { id: 'email-3' } });
  await store.setOutcome(record.id, 'acted');

  const summary = await store.summary();
  assert.equal(summary.acted, 1);
  assert.equal(summary.thresholds.domain.positives, 1);
});

test('feedback rejects bad ids and non-ratings', async () => {
  const store = new GoalMatchStore({ stateStore: createStateStore() });
  await assert.rejects(() => store.setFeedback('not-a-uuid', { rating: 'positive' }), /Invalid match id/);
  await assert.rejects(() => store.setFeedback(crypto.randomUUID(), { rating: 'maybe' }), /positive or negative/);
});
