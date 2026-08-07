---
name: blackboard-deadlines
description: Check Blackboard on demand via check_blackboard; interpret error codes vs assignment payloads.
---

# Blackboard deadlines

## On-demand

1. Call `check_blackboard()`.
2. Interpret:
   - String starting `BLACKBOARD_` → relay the human-readable error. `BLACKBOARD_LOGIN_REQUIRED` means re-run `node login-blackboard.js` on the Mac.
   - JSON `{"source":"blackboard_ical","assignments":[...]}` → filter/sort for the ask.
   - Other text → summarize yourself for the question asked.

## Scheduled (context only)

Daily 7am job alerts for deadlines within 3 days with dedupe; morning brief folds spoken deadlines. Do not invent alert state from chat.

## Pitfalls

- Treating a `BLACKBOARD_` error string as assignment data.
