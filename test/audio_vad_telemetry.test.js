'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVadDiagnostic } = require('../audio_vad_telemetry');

test('VAD diagnostics retain bounded signal metadata only', () => {
  const observed = new Date('2026-08-13T20:00:00.000Z');
  assert.deepEqual(normalizeVadDiagnostic({
    kind: 'false_start',
    phase: 'barge_in',
    level: 1.5,
    confidence: 0.72,
    noise_floor: -1,
    duration_ms: 92.4,
    reason: 'candidate_lost',
    occurred_at: '2026-08-13T19:59:59.000Z',
    transcript: 'must not survive'
  }, observed), {
    kind: 'false_start',
    phase: 'barge_in',
    level: 1,
    confidence: 0.72,
    noise_floor: 0,
    duration_ms: 92,
    reason: 'candidate_lost',
    occurred_at: '2026-08-13T19:59:59.000Z',
    observed_at: '2026-08-13T20:00:00.000Z'
  });
});

test('VAD diagnostics reject unknown event classes', () => {
  assert.equal(normalizeVadDiagnostic({ kind: 'raw_audio', phase: 'stream' }), null);
  assert.equal(normalizeVadDiagnostic({ kind: 'false_start', phase: 'unknown' }), null);
});
