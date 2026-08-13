const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 15 * 1000;
const DEFAULT_RETRY_MAX_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;

function boundedPositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

function memoryRetryDelayMs(
  attempt,
  { baseMs = DEFAULT_RETRY_BASE_MS, maxMs = DEFAULT_RETRY_MAX_MS } = {}
) {
  const normalizedAttempt = Math.max(1, Number(attempt) || 1);
  return Math.min(maxMs, baseMs * (2 ** Math.min(10, normalizedAttempt - 1)));
}

function safeWorkerError(error) {
  const message = String(error?.message || error || 'Unknown memory extraction error')
    .replace(/\b(?:sk|rk|pk)-[a-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/\beyJ[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/gi, '[redacted]')
    .replace(/\b[a-f0-9]{48,}\b/gi, '[redacted]')
    .slice(0, 500);
  return {
    code: String(error?.code || 'MEMORY_EXTRACTION_FAILED').slice(0, 80),
    message
  };
}

class DurableMemoryExtractionQueue {
  constructor({
    stateStore,
    memory,
    logger = console,
    batchSize = DEFAULT_BATCH_SIZE,
    leaseMs = DEFAULT_LEASE_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RETRY_MAX_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    scheduleImmediate = setImmediate,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  }) {
    if (!stateStore) throw new Error('A durable state store is required.');
    if (!memory?.learnFromUserMessage) throw new Error('Memory v2 is required.');
    this.stateStore = stateStore;
    this.memory = memory;
    this.logger = logger;
    this.batchSize = boundedPositiveInteger(batchSize, DEFAULT_BATCH_SIZE, 100);
    this.leaseMs = boundedPositiveInteger(leaseMs, DEFAULT_LEASE_MS);
    this.maxAttempts = boundedPositiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS, 20);
    this.retryBaseMs = boundedPositiveInteger(retryBaseMs, DEFAULT_RETRY_BASE_MS);
    this.retryMaxMs = boundedPositiveInteger(retryMaxMs, DEFAULT_RETRY_MAX_MS);
    this.pollIntervalMs = boundedPositiveInteger(
      pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS
    );
    this.scheduleImmediate = scheduleImmediate;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.kickScheduled = false;
    this.draining = null;
    this.interval = null;
  }

  async enqueueMessage(messageId) {
    return this.stateStore.enqueueMemoryExtraction(messageId, {
      maxAttempts: this.maxAttempts
    });
  }

  kick() {
    if (this.kickScheduled) return;
    this.kickScheduled = true;
    this.scheduleImmediate(() => {
      this.kickScheduled = false;
      this.drain().catch(error => {
        this.logger.warn('[Memory queue] Background drain failed:', error.message);
      });
    });
  }

  start() {
    if (this.interval) return;
    this.kick();
    this.interval = this.setIntervalFn(() => this.kick(), this.pollIntervalMs);
    this.interval?.unref?.();
  }

  stop() {
    if (this.interval) this.clearIntervalFn(this.interval);
    this.interval = null;
  }

  async drain({ maxJobs = this.batchSize } = {}) {
    if (this.draining) return this.draining;
    this.draining = this.#drain(
      boundedPositiveInteger(maxJobs, this.batchSize, 100)
    ).finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  async #drain(maxJobs) {
    const stats = {
      processed: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      lease_lost: 0
    };

    while (stats.processed < maxJobs) {
      const job = await this.stateStore.claimNextMemoryExtraction({
        leaseMs: this.leaseMs
      });
      if (!job) break;
      stats.processed += 1;

      try {
        const message = await this.stateStore.getMessageForMemoryExtraction(
          job.message_id
        );
        if (!message || message.role !== 'user') {
          const error = new Error('The queued user message no longer exists.');
          error.code = 'MEMORY_MESSAGE_MISSING';
          throw error;
        }
        if (message.metadata?.turn_status === 'cancelled') {
          const completed = await this.stateStore.completeMemoryExtraction(job, {
            learnedCount: 0,
            confirmationCount: 0,
            skipped: 'cancelled_turn'
          });
          if (completed) stats.succeeded += 1;
          else stats.lease_lost += 1;
          continue;
        }
        const result = await this.memory.learnFromUserMessage(message.content, {
          source: 'conversation',
          throwOnExtractionError: true
        });
        const completed = await this.stateStore.completeMemoryExtraction(job, {
          learnedCount: result.learned?.length || 0,
          confirmationCount: result.candidates?.length || 0,
          skipped: result.skipped || null
        });
        if (completed) stats.succeeded += 1;
        else stats.lease_lost += 1;
      } catch (error) {
        const retryDelayMs = memoryRetryDelayMs(job.attempts, {
          baseMs: this.retryBaseMs,
          maxMs: this.retryMaxMs
        });
        const outcome = await this.stateStore.retryMemoryExtraction(
          job,
          safeWorkerError(error),
          {
            delayMs: retryDelayMs,
            maxAttempts: this.maxAttempts
          }
        );
        if (!outcome) {
          stats.lease_lost += 1;
        } else if (outcome.status === 'failed') {
          stats.failed += 1;
          this.logger.warn('[Memory queue] Job reached its retry limit:', {
            job_id: job.id,
            code: error?.code || 'MEMORY_EXTRACTION_FAILED'
          });
        } else {
          stats.retried += 1;
        }
      }
    }
    return stats;
  }
}

module.exports = {
  DurableMemoryExtractionQueue,
  memoryRetryDelayMs,
  safeWorkerError
};
