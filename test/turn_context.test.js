const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BUSINESS_INTEL_TOOL_NAMES,
  OUTBOUND_EMAIL_TOOL_NAMES,
  CALENDAR_WRITE_TOOL_NAMES,
  LINKEDIN_TOOL_NAMES,
  isLightweightChitchat,
  needsSemanticMemory,
  shouldSkipSemanticMemory,
  isDirectFinancialMetricsAsk,
  reasoningEffortForTurn,
  shouldForceWebSearchForTurn,
  shouldRequireLiveToolForTurn,
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
  ...LINKEDIN_TOOL_NAMES,
  'check_email',
  'check_calendar',
  'get_goals',
  'get_goal_plans',
  'add_goal',
  'set_goal_plan',
  'update_goal_step',
  'update_goal_status',
  'set_reminder',
  'get_reminders',
  'cancel_reminder',
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
  assert.equal(isDirectFinancialMetricsAsk('Why did MRR fall, and what should I do?'), false);
});

test('adaptive reasoning keeps direct answers fast and deepens analysis', () => {
  assert.equal(reasoningEffortForTurn('Who paid me last?', { baseEffort: 'low' }), 'low');
  assert.equal(reasoningEffortForTurn("What's my MRR?", { baseEffort: 'low' }), 'low');
  assert.equal(
    reasoningEffortForTurn('Why did MRR fall, and what should I do?', { baseEffort: 'low' }),
    'medium'
  );
  assert.equal(
    reasoningEffortForTurn('Compare delinquent clients and prioritize follow-up', { baseEffort: 'low' }),
    'medium'
  );
  assert.equal(
    reasoningEffortForTurn('Think this through before you answer', { baseEffort: 'none' }),
    'medium'
  );
});

test('adaptive reasoning keeps routine cross-domain reads fast and honors operator floors', () => {
  assert.equal(
    reasoningEffortForTurn('Check both for me', {
      baseEffort: 'low',
      toolNames: ['check_email', 'check_calendar']
    }),
    'low'
  );
  assert.equal(
    reasoningEffortForTurn("What's on my plate today?", {
      baseEffort: 'low',
      toolNames: ['get_goal_plans', 'check_calendar', 'check_blackboard']
    }),
    'low'
  );
  assert.equal(
    reasoningEffortForTurn('Compare my email and calendar and recommend what to prioritize', {
      baseEffort: 'low',
      toolNames: ['check_email', 'check_calendar']
    }),
    'medium'
  );
  assert.equal(
    reasoningEffortForTurn('Who paid me last?', { baseEffort: 'medium' }),
    'medium'
  );
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

test('selectToolsForTurn offers add_goal when the turn says "to do list" (with a space)', () => {
  const selected = selectToolsForTurn(
    fakeTools(ALL_NAMES),
    'Can you add to my to do list, buy a Credit Comeback Club hat?'
  );
  const names = new Set(selected.map(tool => tool.function.name));
  // The write tool must be present - this exact phrasing previously stripped it
  // and AURA reported "I only have read access, there's no add-goal action."
  assert.equal(names.has('add_goal'), true);
  assert.equal(names.has('get_goals'), true);
});

test('selectToolsForTurn offers add_goal for "put X on my list" without the word todo', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), 'Put buying milk on my list');
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('add_goal'), true);
});

test('selectToolsForTurn does not treat "list my emails" as a goal turn', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), 'List my unread emails');
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('add_goal'), false);
});

test('selectToolsForTurn keeps business tools when the turn mentions clients', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), 'What is the balance for client Mary?');
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('get_client_snapshot'), true);
  assert.equal(names.has('calculate_financial_metrics'), true);
  // No email wording → outbound tools still dropped.
  assert.equal(names.has('send_owner_email'), false);
});

test('explicit live-data questions require a first-round tool call', () => {
  assert.equal(shouldRequireLiveToolForTurn(
    'Tell me the latest information about client Mary.',
    ['get_client_snapshot', 'get_client_current_phase']
  ), true);
  assert.equal(shouldRequireLiveToolForTurn(
    'What is on my calendar today?',
    ['check_calendar']
  ), true);
  assert.equal(shouldRequireLiveToolForTurn(
    'Explain what a dispute phase means.',
    ['get_client_current_phase']
  ), false);
  assert.equal(shouldRequireLiveToolForTurn(
    'How should I write this email?',
    ['check_email']
  ), false);
  assert.equal(shouldRequireLiveToolForTurn(
    'Tell me to send that email now.',
    ['check_email']
  ), false);
  assert.equal(shouldRequireLiveToolForTurn('Tell me a joke.', []), false);
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

test('selectToolsForTurn recognizes natural sent-mail questions without offering send tools', () => {
  const selected = selectToolsForTurn(
    fakeTools(ALL_NAMES),
    'I know Stephanie was emailed. Has Jack been emailed too?'
  );
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('check_email'), true);
  assert.equal(names.has('send_owner_email'), false);
  assert.equal(names.has('send_email'), false);
});

test('selectToolsForTurn carries a public contact lookup into a natural retry', () => {
  const recent = [
    { role: 'user', content: 'Find the correct contact email for Bloom Credit.' },
    { role: 'assistant', content: 'I could not verify the official address yet.' }
  ];
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), 'Double-check again.', recent);
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('search_web'), true);
  assert.equal(shouldForceWebSearchForTurn('Double-check again.', recent), true);
  assert.equal(
    shouldForceWebSearchForTurn('Search the web and check client Jack.', recent),
    false,
    'mixed private input must remain on the normal privacy-gated path'
  );
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

test('selectToolsForTurn offers the full calendar lifecycle for move and cancel commands', () => {
  const reschedule = new Set(selectToolsForTurn(
    fakeTools(ALL_NAMES),
    'Reschedule my 10am Pay Gilbert Traffic event to next Tuesday at the same time'
  ).map(tool => tool.function.name));
  assert.equal(reschedule.has('reschedule_calendar_event'), true);
  assert.equal(reschedule.has('cancel_calendar_event'), true);
  assert.equal(reschedule.has('check_calendar'), true);

  const cancellation = new Set(selectToolsForTurn(
    fakeTools(ALL_NAMES),
    'Cancel my Pay Gilbert Traffic calendar event'
  ).map(tool => tool.function.name));
  assert.equal(cancellation.has('cancel_calendar_event'), true);
  assert.equal(cancellation.has('check_calendar'), true);
});

test('selectToolsForTurn offers durable reminders only for reminder turns', () => {
  const reminder = selectToolsForTurn(
    fakeTools(ALL_NAMES),
    'Remind me every Thursday at 9 AM about my discussion post'
  );
  assert.equal(reminder.some(tool => tool.function.name === 'set_reminder'), true);
  assert.equal(reminder.some(tool => tool.function.name === 'get_reminders'), true);
  assert.equal(reminder.some(tool => tool.function.name === 'cancel_reminder'), true);

  const greet = selectToolsForTurn(fakeTools(ALL_NAMES), 'Hey, what is up?');
  assert.equal(greet.some(tool => tool.function.name === 'set_reminder'), false);
  assert.equal(greet.some(tool => tool.function.name === 'get_reminders'), false);
  assert.equal(greet.some(tool => tool.function.name === 'cancel_reminder'), false);
});

test('selectToolsForTurn offers LinkedIn tools only for a LinkedIn relationship turn', () => {
  const selected = selectToolsForTurn(
    fakeTools(ALL_NAMES),
    'Draft a LinkedIn thank-you for the person I selected.'
  );
  const names = new Set(selected.map(tool => tool.function.name));
  for (const name of LINKEDIN_TOOL_NAMES) assert.equal(names.has(name), true, name);

  const plain = selectToolsForTurn(fakeTools(ALL_NAMES), 'Tell me a joke.');
  const plainNames = new Set(plain.map(tool => tool.function.name));
  for (const name of LINKEDIN_TOOL_NAMES) assert.equal(plainNames.has(name), false, name);
});

test('LinkedIn approval code follow-ups retain the exact approval tools', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), 'Approve and send LI-12AB34CD.');
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('approve_linkedin_message'), true);
  assert.equal(names.has('draft_linkedin_message'), true);
});

test('selectToolsForTurn treats whats on my plate as todays agenda', () => {
  for (const text of [
    'What is on my plate today?',
    'What does my plate look like today?',
    "Give me today's real agenda and deadlines."
  ]) {
    const selected = selectToolsForTurn(fakeTools(ALL_NAMES), text);
    const names = new Set(selected.map(tool => tool.function.name));
    assert.equal(names.has('get_goals'), true, text);
    assert.equal(names.has('get_goal_plans'), true, text);
    assert.equal(names.has('add_goal'), false, text);
    assert.equal(names.has('set_goal_plan'), false, text);
    assert.equal(names.has('update_goal_step'), false, text);
    assert.equal(names.has('update_goal_status'), false, text);
    assert.equal(names.has('check_calendar'), true, text);
    assert.equal(names.has('check_blackboard'), true, text);
    assert.equal(names.has('check_email'), false, text);
  }
});

test('selectToolsForTurn offers the planning ledger only on planning turns', () => {
  const selected = selectToolsForTurn(
    fakeTools(ALL_NAMES),
    'Make me a plan to launch the new offer'
  );
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('get_goal_plans'), true);
  assert.equal(names.has('set_goal_plan'), true);
  assert.equal(names.has('update_goal_step'), true);
  assert.equal(names.has('check_calendar'), false);
  assert.equal(names.has('send_email'), false);
});

test('selectToolsForTurn offers portfolio reads for a natural next-move question', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), 'What should I do next?');
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('get_goal_plans'), true);
  assert.equal(names.has('get_goals'), true);
});

test('selectToolsForTurn drops calendar write tools on plain chit-chat', () => {
  const selected = selectToolsForTurn(fakeTools(ALL_NAMES), "Hey, what's up?");
  const names = new Set(selected.map(tool => tool.function.name));
  assert.equal(names.has('create_calendar_event'), false);
  assert.equal(names.has('reschedule_calendar_event'), false);
  assert.equal(names.has('cancel_calendar_event'), false);
});
