const test = require('node:test');
const assert = require('node:assert/strict');
const { createSentenceGate, extractTextToolCalls } = require('../reply_stream');

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

test('sentence gate suppresses denials for safe capabilities omitted by the fast router', () => {
  const spoken = [];
  const gate = createSentenceGate(s => spoken.push(s), {
    availableToolNames: [],
    capabilityToolNames: ['check_email']
  });

  gate.onSentence("I don’t have mail access in the tools I can call right now.");
  assert.deepEqual(spoken, []);
  assert.deepEqual(gate.getDenial().tools, ['check_email']);
});

test('sentence gate permits an honest limitation after that tool was attempted', () => {
  const spoken = [];
  const gate = createSentenceGate(s => spoken.push(s), {
    availableToolNames: ['check_calendar'],
    capabilityToolNames: ['check_calendar']
  });
  gate.markToolAttempted('check_calendar');

  gate.onSentence("I don’t have your live calendar loaded in this chat.");
  assert.deepEqual(spoken, ["I don’t have your live calendar loaded in this chat."]);
  assert.equal(gate.getDenial(), null);
});

test('text tool parser recovers only explicitly allowed JSON tool calls', () => {
  const text = [
    '```json',
    '{"tool_call":"get_table_schema","table_name":"clients"}',
    '```',
    '```json',
    '{"tool_call":"calculate_financial_metrics"}',
    '```'
  ].join('\n');
  const calls = extractTextToolCalls(text, {
    allowedToolNames: ['get_table_schema', 'calculate_financial_metrics']
  });

  assert.deepEqual(calls.map(call => ({ name: call.name, arguments: call.arguments })), [
    { name: 'get_table_schema', arguments: { table_name: 'clients' } },
    { name: 'calculate_financial_metrics', arguments: {} }
  ]);
});

test('text tool parser ignores unoffered and write tools', () => {
  const text = [
    '{"tool_call":"send_owner_email","subject":"oops"}',
    '{"tool_call":"unknown_tool"}'
  ].join('\n');
  assert.deepEqual(extractTextToolCalls(text, {
    allowedToolNames: ['get_client_snapshot']
  }), []);
});

test('sentence gate keeps raw tool protocol out of spoken audio', () => {
  const spoken = [];
  const gate = createSentenceGate(sentence => spoken.push(sentence), {
    availableToolNames: ['get_table_schema']
  });

  gate.onSentence('Let me check that.');
  gate.onSentence('```json\n{"tool_call":"get_table_schema","table_name":"clients"}\n```');

  assert.deepEqual(spoken, ['Let me check that.']);
  assert.equal(gate.wasSuppressed(), true);
  assert.equal(gate.getProtocolLeak().calls[0].name, 'get_table_schema');

  gate.resetAfterToolRecovery();
  gate.onSentence('Jordan paid most recently.');
  assert.deepEqual(spoken, ['Let me check that.', 'Jordan paid most recently.']);
});

test('sentence gate blocks unknown raw tool protocol even when it cannot recover it', () => {
  const spoken = [];
  const gate = createSentenceGate(sentence => spoken.push(sentence), {
    availableToolNames: ['get_table_schema']
  });

  gate.onSentence('{"tool_call":"invented_dangerous_tool"}');

  assert.deepEqual(spoken, []);
  assert.equal(gate.wasSuppressed(), true);
  assert.deepEqual(gate.getProtocolLeak().calls, []);
});
