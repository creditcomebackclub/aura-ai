const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BUSINESS_INTEL_TOOL_NAMES,
  OUTBOUND_EMAIL_TOOL_NAMES,
  CALENDAR_WRITE_TOOL_NAMES,
  isLightweightChitchat,
  needsSemanticMemory,
  shouldSkipSemanticMemory,
  isDirectFinancialMetricsAsk,
  selectToolsForTurn,
  historyLimitForTurn,
  LIGHTWEIGHT_HISTORY_LIMIT,
  DEFAULT_HISTORY_LIMIT,
  FULL_HISTORY_LIMIT,
  DIRECT_METRICS_HISTORY_LIMIT,
  correctCommonSpeechTerms
} = require('../turn_context');

function fakeTools(names) {
  return names.map(name => ({ type: 'function', function: { name } }));
}

const ALL_NAMES = [
  ...BUSINESS_INTEL_TOOL_NAMES,
  ...OUTBOUND_EMAIL_TOOL_NAMES,
  ...CALENDAR_WRITE_TOOL_NAMES,
  'check_email',
  'check_calendar',
  'get_goals',
  'search_web',
  'send_telegram_message',
  'list_skills',
  'save_semantic_memory',
  'check_blackboard',
  'log_finance'
];

test('isLightweightChitchat accepts short greets', () => {
  assert.equal(isLightweightChitchat("Hey, what's up?"), true);
  assert.equal(isLightweightChitchat('hi'), true);
  assert.equal(isLightweightChitchat('good morning'), true);
  assert.equal(isLightweightChitchat('hey aura'), true);
});

test('isLightweightChitchat rejects status / business / long turns', () => {
  assert.equal(isLightweightChitchat('any email?'), false);
  assert.equal(isLightweightChitchat("what's on my calendar"), false);
  assert.equal(isLightweightChitchat('how many clients owe money'), false);
  assert.equal(isLightweightChitchat('send an email to myself about lunch'), false);
  assert.equal(isLightweightChitchat("What's my MMR?"), false);
  assert.equal(isLightweightChitchat("What's my MRR?"), false);
  assert.equal(isLightweightChitchat('Yeah, OK.'), false);
  assert.equal(isLightweightChitchat('x'.repeat(81)), false);
});

test('semantic memory is opt-in, not default', () => {
  assert.equal(needsSemanticMemory("What's my MRR?"), false);
  assert.equal(shouldSkipSemanticMemory("What's my MRR?"), true);
  assert.equal(shouldSkipSemanticMemory('tell me a joke'), true);
  assert.equal(needsSemanticMemory('what did you tell me last time'), true);
  assert.equal(shouldSkipSemanticMemory('what did you tell me last time'), false);
});

test('direct financial metrics asks are detected', () => {
  assert.equal(isDirectFinancialMetricsAsk("What's my MRR?"), true);
  assert.equal(isDirectFinancialMetricsAsk('Yes, I meant MRR.'), true);
  assert.equal(isDirectFinancialMetricsAsk('email me the MRR'), false);
});

test('selectToolsForTurn keeps finance tools for MMR speech typo', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), "What's my MMR?");
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('calculate_financial_metrics'), true);
  assert.equal(names.has('check_email'), false);
  assert.equal(names.has('get_goals'), false);
});

test('historyLimitForTurn shrinks on greets and metric reads', () => {
  assert.equal(historyLimitForTurn("Hey, what's up?"), LIGHTWEIGHT_HISTORY_LIMIT);
  assert.equal(historyLimitForTurn("What's my MRR?"), DIRECT_METRICS_HISTORY_LIMIT);
  assert.equal(historyLimitForTurn('pull the outstanding balances'), DIRECT_METRICS_HISTORY_LIMIT);
  assert.equal(historyLimitForTurn('tell me a joke'), DEFAULT_HISTORY_LIMIT);
  assert.equal(historyLimitForTurn('look up client Mary phase'), FULL_HISTORY_LIMIT);
});

test('correctCommonSpeechTerms rewrites MMR to MRR', () => {
  assert.equal(correctCommonSpeechTerms("What's my MMR?"), "What's my MRR?");
  assert.equal(correctCommonSpeechTerms('mmr is up'), 'MRR is up');
  assert.equal(correctCommonSpeechTerms('hammer'), 'hammer');
});

test('selectToolsForTurn drops gated tools on plain chit-chat', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), "Hey, what's up?");
  const names = new Set(selected.map(tool => tool.function.name));
  for (const name of BUSINESS_INTEL_TOOL_NAMES) assert.equal(names.has(name), false, name);
  for (const name of OUTBOUND_EMAIL_TOOL_NAMES) assert.equal(names.has(name), false, name);
  assert.equal(names.has('check_email'), false);
  assert.equal(names.has('search_web'), false);
  assert.equal(names.has('get_goals'), false);
  assert.equal(names.has('check_calendar'), false);
});

test('selectToolsForTurn keeps business tools when the turn mentions clients', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), 'What is the balance for client Mary?');
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('get_client_snapshot'), true);
  assert.equal(names.has('calculate_financial_metrics'), true);
  // No email wording → outbound tools still dropped.
  assert.equal(names.has('send_owner_email'), false);
});

test('selectToolsForTurn inherits business relevance from recent history', () => {
  const recent = [
    { role: 'user', content: 'Look up client David Moya' },
    { role: 'assistant', content: 'I have his snapshot.' }
  ];
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), 'What about for his wife?', recent);
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('get_client_snapshot'), true);
});

test('selectToolsForTurn keeps outbound email tools when the turn asks to send', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), 'Email me a summary of today');
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('send_owner_email'), true);
  assert.equal(names.has('send_email'), true);
  assert.equal(names.has('check_email'), true);
});

test('selectToolsForTurn keeps calendar write tools when scheduling', () => {
  const selected = selectToolsForTurn(
    fakeTools(ALL_NAMES),
    'Schedule a consult with David on Monday at 9'
  );
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('create_calendar_event'), true);
  assert.equal(names.has('check_calendar'), true);
  assert.equal(names.has('send_owner_email'), false);
});

test('selectToolsForTurn drops calendar write tools on plain chit-chat', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), "Hey, what's up?");
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('create_calendar_event'), false);
});
