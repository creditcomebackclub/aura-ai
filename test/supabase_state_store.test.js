const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isCancelledConversationMessage,
  visibleConversationMessages
} = require('../supabase_state_store');

test('cancelled conversation turns are excluded from model and summary context', () => {
  const messages = [
    { id: 1, role: 'assistant', content: 'Earlier answer.', metadata: {} },
    {
      id: 2,
      role: 'user',
      content: 'Interrupted thought.',
      metadata: { turn_status: 'cancelled' }
    },
    { id: 3, role: 'user', content: 'Complete question.', metadata: {} }
  ];

  assert.equal(isCancelledConversationMessage(messages[1]), true);
  assert.equal(isCancelledConversationMessage(messages[2]), false);
  assert.deepEqual(
    visibleConversationMessages(messages, 2).map(message => message.id),
    [1, 3]
  );
});
