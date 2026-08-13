'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertAgentCanUseTool,
  buildAgentPrompt,
  filterToolsForAgent,
  mergeAgentRegistry,
  routeAgentForTurn,
  routeAgentId
} = require('../agent_router');

test('router sends narrow read questions to specialists', () => {
  assert.equal(routeAgentId('Who was the last client that paid me?'), 'finance');
  assert.equal(routeAgentId('How much is outstanding right now?'), 'finance');
  assert.equal(routeAgentId('How many clients owe me money?'), 'finance');
  assert.equal(routeAgentId('What phase is David Roberts in?'), 'client_operations');
  assert.equal(routeAgentId('How many active clients do I have?'), 'client_operations');
});

test('router keeps mixed, ambiguous, and action turns on Core', () => {
  assert.equal(routeAgentId('Who owes me money and what phase are they in?'), 'aura_core');
  assert.equal(routeAgentId('Send Cameron an invoice'), 'aura_core');
  assert.equal(routeAgentId('Give me an update'), 'aura_core');
  assert.equal(routeAgentId('Delete that test letter'), 'aura_core');
});

test('disabled database specialists fall back to Core', () => {
  const registry = mergeAgentRegistry([{ id: 'finance', enabled: false }]);
  assert.equal(routeAgentForTurn('What is MRR?', registry).id, 'aura_core');
});

test('specialist tools are filtered and enforced at execution', () => {
  const finance = mergeAgentRegistry().finance;
  const tools = [
    { function: { name: 'calculate_financial_metrics' } },
    { function: { name: 'send_email' } }
  ];
  assert.deepEqual(
    filterToolsForAgent(tools, finance).map(tool => tool.function.name),
    ['calculate_financial_metrics']
  );
  assert.equal(assertAgentCanUseTool(finance, 'calculate_financial_metrics', 'read'), true);
  assert.throws(
    () => assertAgentCanUseTool(finance, 'send_email', 'external_action'),
    /outside finance's allowlist/
  );
});

test('specialist prompt preserves AURA identity and states the risk ceiling', () => {
  const prompt = buildAgentPrompt(mergeAgentRegistry().client_operations);
  assert.match(prompt, /Client Operations Agent/);
  assert.match(prompt, /AURA's normal voice/);
  assert.match(prompt, /limited to read operations/);
});
