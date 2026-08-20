const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isCancelledConversationMessage,
  SupabaseStateStore,
  summarizeMemoryExtractionJobs,
  visibleConversationMessages
} = require('../supabase_state_store');

test('cancelled conversation turns are excluded from model and summary context', () => {
  const messages = [
    { id: 1, role: 'assistant', content: 'Earlier answer.', metadata: {} },
    {
      id: 2,
      role: 'user',
      content: 'Interrupted thought.',
      metadata: { turn_status: 'cancelled' }
    },
    { id: 3, role: 'user', content: 'Complete question.', metadata: {} }
  ];

  assert.equal(isCancelledConversationMessage(messages[1]), true);
  assert.equal(isCancelledConversationMessage(messages[2]), false);
  assert.deepEqual(
    visibleConversationMessages(messages, 2).map(message => message.id),
    [1, 3]
  );
});

test('memory extraction health summarizes failures without message content', () => {
  const summary = summarizeMemoryExtractionJobs([
    { id: '1', message_id: '1', status: 'queued' },
    { id: '2', message_id: '2', status: 'failed', attempts: 5, completed_at: '2026-08-20T12:00:00Z', last_error: { code: 'MODEL_DOWN' } }
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.queued, 1);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.latest_failure.error, { code: 'MODEL_DOWN' });
  assert.equal(JSON.stringify(summary).includes('message content'), false);
});

test('owner profile mutation retries CAS conflicts and preserves concurrent entries', async () => {
  let token = '2026-08-20T00:00:00.000Z';
  let value = { version: 1, entries: { existing: { key: 'existing', value: 'kept' } } };
  let calls = 0;
  const store = Object.create(SupabaseStateStore.prototype);
  store.profileWrite = Promise.resolve();
  store.getStateRow = async () => ({ value: structuredClone(value), updated_at: token });
  store.compareAndSetState = async (_key, expected, next) => {
    calls += 1;
    if (calls === 1) {
      value.entries.concurrent = { key: 'concurrent', value: 'survives' };
      token = '2026-08-20T00:00:00.001Z';
      return false;
    }
    assert.equal(expected, token);
    value = structuredClone(next);
    return true;
  };

  await store.upsertOwnerProfileEntries([{ key: 'new', value: 'saved' }]);
  assert.deepEqual(Object.keys(value.entries).sort(), ['concurrent', 'existing', 'new']);
  assert.equal(calls, 2);
});

test('failed memory extraction replay is guarded by the current job status', async () => {
  const store = Object.create(SupabaseStateStore.prototype);
  store.getMemoryExtractionJob = async () => ({
    id: '42',
    version: 1,
    message_id: '42',
    idempotency_key: 'message:42',
    status: 'failed',
    attempts: 5,
    max_attempts: 5,
    created_at: '2026-08-19T00:00:00.000Z',
    completed_at: '2026-08-20T00:00:00.000Z',
    last_error: { code: 'MODEL_DOWN' }
  });
  let transitioned = null;
  store.transitionMemoryExtractionJob = async (job, next) => {
    transitioned = { job, next };
    return { ...next, id: job.id };
  };

  const result = await store.requeueFailedMemoryExtraction('42');
  assert.equal(result.requeued, true);
  assert.equal(transitioned.next.status, 'queued');
  assert.equal(transitioned.next.attempts, 0);
  assert.equal(transitioned.next.last_error, null);
  assert.ok(transitioned.next.replayed_at);

  store.getMemoryExtractionJob = async () => ({ id: '42', status: 'processing' });
  assert.deepEqual(await store.requeueFailedMemoryExtraction('42'), {
    requeued: false,
    reason: 'not_failed',
    job: { id: '42', status: 'processing' }
  });
});

test('task updates can require the unresolved review status', async () => {
  const predicates = [];
  let writtenPatch = null;
  const query = {
    update(patch) { writtenPatch = patch; return this; },
    eq(column, value) { predicates.push([column, value]); return this; },
    select() { return this; },
    async maybeSingle() { return { data: { id: 'task-1', ...writtenPatch }, error: null }; }
  };
  const store = Object.create(SupabaseStateStore.prototype);
  store.ownerId = 'owner-1';
  store.client = { from: () => query };

  await store.updateTask('task-1', {
    status: 'pending',
    expectedStatus: 'awaiting_approval'
  });
  assert.deepEqual(predicates, [
    ['owner_id', 'owner-1'],
    ['id', 'task-1'],
    ['status', 'awaiting_approval']
  ]);
});

test('candidate mutations retry against the latest candidate list', async () => {
  let token = '2026-08-20T00:00:00.000Z';
  let value = { version: 1, entries: {}, memory_candidates: [{ id: 'remove-me' }] };
  let calls = 0;
  const store = Object.create(SupabaseStateStore.prototype);
  store.profileWrite = Promise.resolve();
  store.getStateRow = async () => ({ value: structuredClone(value), updated_at: token });
  store.compareAndSetState = async (_key, _expected, next) => {
    calls += 1;
    if (calls === 1) {
      value.memory_candidates.push({ id: 'concurrent-candidate' });
      token = '2026-08-20T00:00:00.001Z';
      return false;
    }
    value = structuredClone(next);
    return true;
  };

  await store.mutateOwnerMemoryCandidates(candidates =>
    candidates.filter(candidate => candidate.id !== 'remove-me'));
  assert.deepEqual(value.memory_candidates, [{ id: 'concurrent-candidate' }]);
});
