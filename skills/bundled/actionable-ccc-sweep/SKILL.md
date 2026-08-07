---
name: actionable-ccc-sweep
description: Sweep unsigned LPOAs, unmailed letters, and outstanding balances with the right tools per category.
---

# Actionable CCC sweep

Use for "what needs attention" across unsigned LPOAs, unmailed letters, and money owed.

## Procedure

1. Unsigned LPOAs — `query_database_table` on `clients` with `lpoa_signed_at` `is_null`. If truncated, `count_database_rows` with the same filter.
2. Unmailed letters — same pattern on `letters` / `mailed_date` `is_null`. Unmailed ≠ deletable test letter.
3. Outstanding balances — always `get_outstanding_balances()`. Never filter a balance column on `clients` (amounts live in nested `ledger` JSON).
4. Combined sweep — run all three; explicitly say when a category is clean.

## Pitfalls

- Treating unmailed letters as safe to delete.
- Approximating age-thresholded overdue from ledger dates; that stricter check is cron-only today.
