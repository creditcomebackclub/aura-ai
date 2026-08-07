---
name: test-letter-deletion
description: Propose then confirm deletion of deletable test letters across two turns; never same-turn confirm.
---

# Test-letter deletion

Destructive write. Server enforces propose → later-turn confirm.

## Procedure

1. `list_deletable_test_letters` — only unmailed letters whose client_name and furnisher match the test pattern.
2. Copy the exact `letter_id` from the list. Never reconstruct an id.
3. `propose_test_letter_deletion(letter_id)` — stages only. Describe the letter and ask Chris to confirm out loud, then STOP.
4. On a **later** turn after clear approval words, `confirm_test_letter_deletion(letter_id)`.
5. If the id is wrong, the error names staged ids — retry immediately with the corrected id.
6. On success, report audit id and timestamp. If >10 minutes elapsed, re-propose.

## Pitfalls

- Proposing and confirming in the same turn (always rejected).
- Asking Chris to repeat approval instead of calling confirm after he already approved.
- Inventing a letter id from memory.
