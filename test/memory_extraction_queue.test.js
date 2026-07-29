const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DurableMemoryExtractionQueue,
  memoryRetryDelayMs,
  safeWorkerError
} = require('../memory_extraction_queue');

function createQueueStore(job, message = { role: 'user', content: 'I prefer concise replies.' }) {
  let claimed = false;
  return {
    completed: [],
    retried: [],
    async enqueueMemoryExtraction(messageId) {
      return { id: String(messageId), message_id: String(messageId), status: 'queued' };
    },
    async claimNextMemoryExtraction() {
      if (claimed) return null;
      claimed = true;
      return { ...job };
    },
    async getMessageForMemoryExtraction() {
      return message;
    },
    async completeMemoryExtraction(claimedJob, result) {
      this.completed.push({ job: claimedJob, result });
      return { status: 'succeeded' };
    },
    async retryMemoryExtraction(claimedJob, error, options) {
      this.retried.push({ job: claimedJob, error, options });
      return { status: 'retry_wait' };
    }
  };
}

test('durable memory queue completes a persisted user-message job', async () => {
  const store = createQueueStore({
    id: '41',
    message_id: '41',
    attempts: 1,
    max_attempts: 5
  });
  const memory = {
    async learnFromUserMessage(text, options) {
      assert.equal(text, 'I prefer concise replies.');
      assert.deepEqual(options, {
        source: 'conversation',
        throwOnExtractionError: true
      });
      return { learned: [{ key: 'communication.concise' }] };
    }
  };
  const queue = new DurableMemoryExtractionQueue({ stateStore: store, memory });
  assert.equal((await queue.enqueueMessage(41)).status, 'queued');
  assert.deepEqual(await queue.drain(), {
    processed: 1,
    succeeded: 1,
    retried: 0,
    failed: 0,
    lease_lost: 0
  });
  assert.equal(store.completed[0].result.learnedCount, 1);
});

test('failed Luna work is safely retried without leaking credentials', async () => {
  const store = createQueueStore({
    id: '42',
    message_id: '42',
    attempts: 2,
    max_attempts: 5
  });
  const memory = {
    async learnFromUserMessage() {
      throw new Error('provider failed with sk-super-secret-key-material');
    }
  };
  const queue = new DurableMemoryExtractionQueue({
    stateStore: store,
    memory,
    retryBaseMs: 1000,
    retryMaxMs: 60000
  });
  const result = await queue.drain();
  assert.equal(result.retried, 1);
  assert.equal(store.retried.length, 1);
  assert.doesNotMatch(store.retried[0].error.message, /super-secret/);
  assert.equal(store.retried[0].options.delayMs, 2000);
});

test('memory retry backoff is bounded and worker errors are sanitized', () => {
  assert.equal(memoryRetryDelayMs(1, { baseMs: 1000, maxMs: 10000 }), 1000);
  assert.equal(memoryRetryDelayMs(8, { baseMs: 1000, maxMs: 10000 }), 10000);
  assert.deepEqual(
    safeWorkerError({ code: 'UPSTREAM', message: 'token sk-secret-value-123456789' }),
    { code: 'UPSTREAM', message: 'token [redacted]' }
  );
  assert.equal(
    safeWorkerError({ message: 'token 5194d9fc7edcb2e2870d6b33ac361271f9774cbd589e5dc15457e0e5b0d638cf' })
      .message,
    'token [redacted]'
  );
});
