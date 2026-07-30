const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// SOUL.md is loaded once at server boot and IS AURA's system prompt. This is
// the regression guard for that move: the safety-critical phrases below were
// each added after observing a real failure without them (see Section 7 in
// the file itself). No mocking - a plain read, so a future edit that silently
// drops one of these is caught by `npm test` before it ships.
const soul = fs.readFileSync(path.join(__dirname, '..', 'SOUL.md'), 'utf8');

test('SOUL.md preserves the proven-necessary safety and accuracy instructions', () => {
  assert.match(soul, /propose_test_letter_deletion/);
  assert.match(soul, /confirm_test_letter_deletion/);
  assert.match(soul, /list_deletable_test_letters/);
  assert.match(soul, /Never reconstruct a letter id/i);
  assert.match(soul, /ALWAYS safe to attempt/);
  assert.match(soul, /call `count_database_rows`/);
  assert.match(soul, /never override security, authorization, or accuracy/i);
  assert.match(soul, /Guess client identities/i);
  assert.match(soul, /State numerical totals from truncated/i);
  assert.match(soul, /NEVER.{0,40}search_web.{0,40}private/is);
});

test('the delete-routes description matches the actual staged approval flow, not immediate deletion', () => {
  assert.match(soul, /stage the deletion into the pending-actions approval queue/i);
  assert.match(soul, /POST `?\/api\/actions\/:id\/approve`?/);
  // The old, factually-wrong claim this replaced must not reappear verbatim.
  assert.doesNotMatch(
    soul,
    /Deleting or modifying long-term memory entries and pinned owner profile keys \(`DELETE/
  );
});
