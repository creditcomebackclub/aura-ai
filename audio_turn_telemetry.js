'use strict';

const ALLOWED_KINDS = new Set([
  'stream_event_rejected',
  'playback_started',
  'playback_completed',
  'alert_deferred',
  'alert_delivered',
  'turn_cancelled'
]);

function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.max(minimum, Math.min(maximum, number)));
}

function normalizeAudioTurnDiagnostic(payload, observedAt = new Date()) {
  if (!payload || !ALLOWED_KINDS.has(payload.kind)) return null;
  const clientDate = typeof payload.occurred_at === 'string'
    ? new Date(payload.occurred_at)
    : new Date(NaN);
  const turnId = typeof payload.turn_id === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(payload.turn_id)
    ? payload.turn_id
    : '';
  return {
    kind: payload.kind,
    turn_id: turnId,
    generation: boundedInteger(payload.generation, 0, 1000000),
    sequence: boundedInteger(payload.sequence, 0, 1000000),
    queue_depth: boundedInteger(payload.queue_depth, 0, 100),
    duration_ms: boundedInteger(payload.duration_ms, 0, 600000),
    reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 40) : '',
    occurred_at: Number.isFinite(clientDate.getTime())
      ? clientDate.toISOString()
      : observedAt.toISOString(),
    observed_at: observedAt.toISOString()
  };
}

module.exports = { normalizeAudioTurnDiagnostic };
