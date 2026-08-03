const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BUSINESS_INTEL_TOOL_NAMES,
  OUTBOUND_EMAIL_TOOL_NAMES,
  CALENDAR_WRITE_TOOL_NAMES,
  isLightweightChitchat,
  selectToolsForTurn,
  historyLimitForTurn,
  LIGHTWEIGHT_HISTORY_LIMIT,
  FULL_HISTORY_LIMIT
} = require('../turn_context');

function fakeTools(names) {
  return names.map(name => ({ type: 'function', function: { name } }));
}

const ALL_NAMES = [
  ...BUSINESS_INTEL_TOOL_NAMES,
  ...OUTBOUND_EMAIL_TOOL_NAMES,
  ...CALENDAR_WRITE_TOOL_NAMES,
  'list_pending_owner_actions',
  'check_email',
  'check_calendar',
  'get_goals',
  'search_web',
  'send_telegram_message'
];

test('isLightweightChitchat accepts short greets', () => {
  assert.equal(isLightweightChitchat("Hey, what's up?"), true);
  assert.equal(isLightweightChitchat('hi'), true);
  assert.equal(isLightweightChitchat('good morning'), true);
});

test('isLightweightChitchat rejects status / business / long turns', () => {
  assert.equal(isLightweightChitchat('any email?'), false);
  assert.equal(isLightweightChitchat("what's on my calendar"), false);
  assert.equal(isLightweightChitchat('how many clients owe money'), false);
  assert.equal(isLightweightChitchat('send an email to myself about lunch'), false);
  assert.equal(isLightweightChitchat('x'.repeat(81)), false);
});

test('historyLimitForTurn shrinks on lightweight greets', () => {
  assert.equal(historyLimitForTurn("Hey, what's up?"), LIGHTWEIGHT_HISTORY_LIMIT);
  assert.equal(historyLimitForTurn('pull the outstanding balances'), FULL_HISTORY_LIMIT);
});

test('selectToolsForTurn drops business + outbound email tools on plain chit-chat', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), "Hey, what's up?");
  const names = new Set(selected.map(tool => tool.function.name));
  for (const name of BUSINESS_INTEL_TOOL_NAMES) assert.equal(names.has(name), false, name);
  for (const name of OUTBOUND_EMAIL_TOOL_NAMES) assert.equal(names.has(name), false, name);
  assert.equal(names.has('check_email'), true);
  assert.equal(names.has('search_web'), true);
});

test('selectToolsForTurn keeps business tools when the turn mentions clients', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), 'What is the balance for client Mary?');
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('get_client_snapshot'), true);
  assert.equal(names.has('calculate_financial_metrics'), true);
  // No email wording → outbound tools still dropped.
  assert.equal(names.has('propose_owner_email'), false);
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
  assert.equal(names.has('propose_owner_email'), true);
  assert.equal(names.has('confirm_owner_email'), true);
  assert.equal(names.has('list_pending_owner_actions'), true);
});

test('selectToolsForTurn keeps calendar write tools when scheduling', () => {
  const selected = selectToolsForTurn(
    fakeTools(ALL_NAMES),
    'Schedule a consult with David on Monday at 9'
  );
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('create_calendar_event'), true);
  assert.equal(names.has('list_pending_owner_actions'), false);
  assert.equal(names.has('propose_owner_email'), false);
});

test('selectToolsForTurn drops calendar write tools on plain chit-chat', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), "Hey, what's up?");
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('create_calendar_event'), false);
  assert.equal(names.has('list_pending_owner_actions'), false);
});
