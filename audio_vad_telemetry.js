'use strict';

const ALLOWED_KINDS = new Set(['false_start', 'suspected_false_cutoff']);
const ALLOWED_PHASES = new Set(['barge_in', 'batch', 'stream']);

function boundedNumber(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(minimum, Math.min(maximum, number));
}

function normalizeVadDiagnostic(payload, observedAt = new Date()) {
  if (!payload || !ALLOWED_KINDS.has(payload.kind) || !ALLOWED_PHASES.has(payload.phase)) {
    return null;
  }
  const clientDate = typeof payload.occurred_at === 'string'
    ? new Date(payload.occurred_at)
    : new Date(NaN);
  const occurredAt = Number.isFinite(clientDate.getTime())
    ? clientDate.toISOString()
    : observedAt.toISOString();
  return {
    kind: payload.kind,
    phase: payload.phase,
    level: boundedNumber(payload.level, 0, 1),
    confidence: boundedNumber(payload.confidence, 0, 1),
    noise_floor: boundedNumber(payload.noise_floor, 0, 1),
    duration_ms: Math.round(boundedNumber(payload.duration_ms, 0, 60000)),
    reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 40) : '',
    occurred_at: occurredAt,
    observed_at: observedAt.toISOString()
  };
}

module.exports = { normalizeVadDiagnostic };
