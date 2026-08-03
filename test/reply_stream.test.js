const test = require('node:test');
const assert = require('node:assert/strict');
const { createSentenceGate } = require('../reply_stream');

test('sentence gate streams clean replies immediately', () => {
  const spoken = [];
  const gate = createSentenceGate(s => spoken.push(s), {
    availableToolNames: ['get_client_snapshot']
  });

  gate.onSentence('Mary is in phase two.');
  gate.onSentence('Her POA is signed.');

  assert.deepEqual(spoken, ['Mary is in phase two.', 'Her POA is signed.']);
  assert.equal(gate.wasSuppressed(), false);
  assert.equal(gate.getDenial(), null);
});

test('sentence gate suppresses a denying sentence and keeps earlier clean audio', () => {
  const spoken = [];
  const gate = createSentenceGate(s => spoken.push(s), {
    availableToolNames: ['get_client_snapshot', 'check_email']
  });

  gate.onSentence('Hmm.');
  gate.onSentence("I don't have access to the client database.");
  gate.onSentence('Want me to try something else?');

  assert.deepEqual(spoken, ['Hmm.']);
  assert.equal(gate.wasSuppressed(), true);
  assert.ok(gate.getDenial());
  assert.ok(gate.getDenial().tools.includes('get_client_snapshot'));

  gate.beginCorrection();
  gate.onSentence('Mary is currently in dispute phase two.');
  assert.deepEqual(spoken, ['Hmm.', 'Mary is currently in dispute phase two.']);
});

test('sentence gate ignores denials for tools that were not offered', () => {
  const spoken = [];
  const gate = createSentenceGate(s => spoken.push(s), {
    availableToolNames: ['check_email']
  });

  gate.onSentence("I don't have access to the client database.");
  assert.deepEqual(spoken, ["I don't have access to the client database."]);
  assert.equal(gate.wasSuppressed(), false);
});
