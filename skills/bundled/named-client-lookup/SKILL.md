---
name: named-client-lookup
description: Answer questions about a named CCC client via snapshot/phase tools, never guess identities.
---

# Named-client lookup

Use when Chris asks about a specific client — status, billing, phase, letters, balance.

## Procedure

1. Pass the name as spoken/written to `get_client_snapshot` (general) or `get_client_current_phase` (phase/round). Do not "clean" it first; fuzzy matching is server-side.
2. Handle outcomes:
   - `found: true` → use returned data.
   - `ambiguous: true` → read candidates aloud; never pick the top score yourself.
   - `found: false` → say so; they may be a lead, not an enrolled client.
3. Fall back to `list_database_tables` → `get_table_schema` → `query_database_table` only when snapshot tools don't cover the ask. Use `op: "match"` for names; always pass `order_by` for "latest".
4. Any "how many" question → `count_database_rows` with the same filters. Never total from a truncated page.
5. Never invent ids. Re-query if lost.

## Pitfalls

- Guessing an ambiguous name match.
- Counting `query_database_table` rows instead of `count_database_rows`.
