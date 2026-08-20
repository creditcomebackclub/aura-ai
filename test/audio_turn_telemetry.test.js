'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAudioTurnDiagnostic } = require('../audio_turn_telemetry');

test('audio turn telemetry accepts bounded metadata without speech content', () => {
  const observedAt = new Date('2026-08-20T12:00:00.000Z');
  assert.deepEqual(normalizeAudioTurnDiagnostic({
    kind: 'stream_event_rejected',
    turn_id: 'turn_12345678',
    generation: 1,
    sequence: 7,
    queue_depth: 999,
    duration_ms: 12.4,
    reason: 'wrong_turn',
    occurred_at: '2026-08-20T11:59:59.000Z',
    transcript: 'must not survive normalization'
  }, observedAt), {
    kind: 'stream_event_rejected',
    turn_id: 'turn_12345678',
    generation: 1,
    sequence: 7,
    queue_depth: 100,
    duration_ms: 12,
    reason: 'wrong_turn',
    occurred_at: '2026-08-20T11:59:59.000Z',
    observed_at: '2026-08-20T12:00:00.000Z'
  });
});

test('audio turn telemetry rejects unknown event kinds', () => {
  assert.equal(normalizeAudioTurnDiagnostic({ kind: 'raw_audio' }), null);
});
