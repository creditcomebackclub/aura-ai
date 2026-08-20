'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createStreamFence,
  shouldDeferProactiveAlert
} = require('../public/voice_turn_protocol');

test('stream fence accepts only the live generation in monotonic order', () => {
  const fence = createStreamFence('turn_12345678', 2);
  assert.deepEqual(fence.accept({ turn_id: 'turn_12345678', generation: 2, sequence: 1 }), {
    accepted: true,
    reason: ''
  });
  assert.equal(fence.accept({ turn_id: 'turn_87654321', generation: 2, sequence: 2 }).reason, 'wrong_turn');
  assert.equal(fence.accept({ turn_id: 'turn_12345678', generation: 1, sequence: 2 }).reason, 'wrong_generation');
  assert.equal(fence.accept({ turn_id: 'turn_12345678', generation: 2, sequence: 1 }).reason, 'stale_sequence');
  assert.equal(fence.accept({ turn_id: 'turn_12345678', generation: 2, sequence: 2 }).accepted, true);
  assert.equal(fence.snapshot().lastSequence, 2);
});

test('stream fence permits old-server events during a mixed-version deploy', () => {
  const fence = createStreamFence('turn_12345678');
  assert.equal(fence.accept({ type: 'sentence', text: 'Hello.' }).accepted, true);
});

test('proactive alerts defer for every active voice phase', () => {
  assert.equal(shouldDeferProactiveAlert({ isProcessing: true }), true);
  assert.equal(shouldDeferProactiveAlert({ isSpeaking: true }), true);
  assert.equal(shouldDeferProactiveAlert({ isListening: true }), true);
  assert.equal(shouldDeferProactiveAlert({}), false);
});
