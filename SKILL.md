---
name: aura-workflows
description: Step-by-step procedures for AURA's recurring domain tasks - named-client lookups, actionable-item sweeps, test-letter deletion, owner email/Telegram, and Blackboard deadline checking. This is the "how the tools get sequenced" layer, distinct from SOUL.md (identity/rules) and TOOLS.md (flat tool reference).
---

# AURA Workflows

This file is the procedural layer of AURA's documentation set. `SOUL.md` says who AURA is and what
she is and is not allowed to do. `TOOLS.md` (a companion reference) will describe each tool in
isolation. This file is neither of those - it is the runbook for AURA's recurring domain tasks,
written so that an agent (human or model) picking up this codebase cold could follow each workflow
mechanically, tool call by tool call.

Every tool named below is defined in the `tools` array in `server.js` (search for its `name:` field)
and dispatched inside `handleToolCall()` in the same file. Where a tool delegates to business logic,
the implementation lives in `ccc_database.js` unless otherwise noted.

---

## 1. Answering a Named-Client Question

Use this whenever the owner (or a user in a business context) asks something about a specific,
named CCC client - status, billing, phase, letters, balance, "what's going on with X."

1. **Extract the name as given.** Do not try to clean it up yourself first. Both client-lookup tools
   run the name through a fuzzy matcher (`normalizeClientName` + Levenshtein-based `scoreClientName`
   in `ccc_database.js`) that already tolerates punctuation, missing middle names/initials, honorifics
   ("Mr.", "Dr.", "client"), and minor transcription errors from speech-to-text. Pass the name close to
   how it was said/written.

2. **Prefer the deterministic snapshot tools over manual table chaining:**
   - `get_client_snapshot(name)` - for general "what's going on with X" questions. Returns status,
     billing_status, billing_tier, current phase, up to 10 recent letters, and the client's
     outstanding ledger entries/total, all in one deterministic call.
   - `get_client_current_phase(name)` - for questions specifically about what phase/round a client
     is in. Returns the current phase plus the actual letter record used as evidence
     (`evidence` field), and the furnishers in that same latest batch (letters saved within 10
     minutes of the most recent one).

   Both tools do their own name resolution and billing/phase logic - do not reconstruct this by
   hand from `query_database_table` unless step 4 applies.

3. **Handle all three possible outcomes of name resolution** (both tools return the same shape):
   - `{"found": true, ...}` - proceed using the returned data. Note `name_match_confidence` if you
     want to gauge how sure the match is.
   - `{"found": false, "ambiguous": true, "matches": [{"id", "name"}, ...]}` - **two or more clients
     scored close enough that guessing would be unsafe.** Read the candidate names back and ask
     which one is meant, or ask for a disambiguating detail (last name, middle initial). Never pick
     the top-scored match yourself - the matcher only returns a single unambiguous match when one
     candidate clearly beats the rest (score gap ≥ 0.1); anything closer than that is intentionally
     surfaced as ambiguous instead of resolved for you.
   - `{"found": false}` with no `matches` - nobody matched at all. Say so; suggest checking spelling,
     or that the person may be a lead rather than an enrolled client (see step 4).

4. **Fall back to generic table access only when the snapshot tools don't cover the question** - e.g.
   the question is about a table other than `clients`/`letters` (leads, client_accounts,
   lpoa_audit_log, etc.), or needs more than the 10 most recent letters, or a field the snapshot
   doesn't surface:
   a. `list_database_tables` - see what tables/views actually exist. Never guess a table name.
   b. `get_table_schema(table_name)` - see the real column names and types before filtering on them.
   c. `query_database_table(table_name, filters, order_by, order_direction, limit)` - filter with
      `op: "match"` for a person's name (partial, case-insensitive, word-order independent - the
      right choice for names, since it will match "Karl Elliot" against a "Karl J. Elliott" row).
      Always pass `order_by` (e.g. `"saved_at"` or `"created_at"`) for any "latest"/"most recent"
      question - without it, ordering is whatever the database happens to return.

5. **Any "how many" question always goes through `count_database_rows`**, with the same
   `table_name`/`filters` you'd otherwise pass to `query_database_table` - never through
   `query_database_table` followed by counting the returned rows yourself. `query_database_table`
   defaults to a 200-row limit and, when more rows matched than were returned, prefixes the result
   with a `"warning": "TRUNCATED: ..."` field naming the true `total_matching_rows`. Never state a
   total from a result carrying that warning; re-run the same filters through `count_database_rows`
   instead, which does a `count: 'exact', head: true` query that never truncates.

6. **Never invent an id.** `client_id`, `letter.id`, `action_id`, etc. must always come from a
   preceding tool result. If you've lost track of an id, re-query rather than reconstruct it from
   a pattern.

---

## 2. Checking for Actionable CCC Items

Use this for a proactive or on-request sweep of "what needs attention" - the three concrete
categories are unsigned LPOAs, unmailed letters, and overdue balances. Each lives in a different
place and needs a different tool/filter; do not assume one query covers all three.

| Category | Table | Signal | How to check |
|---|---|---|---|
| Unsigned LPOA | `clients` | `lpoa_signed_at` is null (cross-checkable against the `lpoa_signed` boolean column, which should agree) | `query_database_table('clients', filters: [{ column: 'lpoa_signed_at', op: 'is_null' }])` |
| Unmailed letter | `letters` | `mailed_date` is null | `query_database_table('letters', filters: [{ column: 'mailed_date', op: 'is_null' }])` |
| Overdue balance | `clients.ledger` (nested) | ledger entry `status` in due/unpaid/pending/overdue/past-due with `amount > 0` | `get_outstanding_balances()` - **never** a column filter on `clients` |

Steps:

1. **Unsigned LPOAs.** Call `query_database_table` with `table_name: "clients"` and an `is_null`
   filter on `lpoa_signed_at` (or `not_null` to find the signed ones, for the complementary
   question). This needs no `value` - `is_null`/`not_null` are presence checks only. If the result
   comes back `TRUNCATED`, get an exact count via `count_database_rows` with the identical filter
   before stating how many are outstanding.

2. **Unmailed letters.** Same pattern against `letters`, filtering `mailed_date` with `op: 'is_null'`.
   Important distinction: "unmailed" is *not* the same thing as "deletable test letter" (workflow 3).
   `mailed_date IS NULL` is only the first of several conditions a letter must meet to be eligible
   for deletion - it must also have both a test-pattern client name *and* furnisher. Don't conflate
   "this letter hasn't gone out yet" (an actionable business item - someone needs to mail it) with
   "this letter is scratch data that's safe to delete."

3. **Overdue balances.** Always call `get_outstanding_balances()` - never try to filter `clients` by
   an amount/balance column directly. Billing amounts live inside `clients.ledger`, a nested JSON
   array, which ordinary column filters (`eq`, `gt`, etc.) cannot see into. The tool walks every
   client's ledger server-side and returns either
   `{"outstanding_clients": [{"client", "total_owed", "entries": [...]}]}` or, if nobody owes
   anything, `{"outstanding_clients": [], "note": "Every client ledger is fully paid."}`.

   Note the distinction between "who owes money right now" (what this tool answers - any open ledger
   entry, regardless of age) and "who just crossed into overdue" (a stricter, age-thresholded
   definition - 3+ days overdue - computed by `ccc.getOverdueClients(3)` for the twice-daily cron
   health check, but **not currently exposed as a chat tool**). If asked specifically for an
   age-thresholded overdue list beyond what `get_outstanding_balances` returns, say this distinction
   needs a code change rather than trying to approximate an SLA cutoff by eyeballing the `date`
   fields in the ledger entries.

4. **For a combined sweep**, run all three checks and report only what's actually outstanding -
   but say explicitly when a category is clean ("no unsigned LPOAs," "every open letter has been
   mailed") rather than omitting it silently. A proactive check that finds nothing wrong still needs
   to say so.

---

## 3. Test-Letter Deletion, End to End

This is the reference implementation of AURA's propose → approve → execute pattern for a
destructive database write. Every step below is enforced server-side, not just by convention - the
model cannot skip the wait by trying harder.

1. **`list_deletable_test_letters()`** - read-only. Returns
   `{"deletable_test_letters": [...], "count": N}`. A letter is only ever included here if `letters.mailed_date`
   is null **and** both `client_name` and `furnisher` match the test-record pattern
   (`/\b(test|delete me|dummy|sample)\b/i`, case-insensitive, whole word). A letter that has actually
   been mailed is never eligible, no matter what it's named - it's a real record of a real dispute.

2. **Pick the exact `letter_id`** from that list (or from a prior `get_client_snapshot`/
   `query_database_table` result). Never guess or reconstruct one.

3. **`propose_test_letter_deletion(letter_id)` - STEP 1, stages only, deletes nothing.** The server
   re-inspects eligibility from scratch (never trusts a stale list) and, if still eligible, writes a
   row to `aura_actions` (`tool_name: 'confirm_test_letter_deletion'`, `risk_level:
   'destructive_write'`, `status: 'proposed'`, with the letter id and a `proposed_at_ms` timestamp in
   `arguments`). The response describes the letter (`client_name`, `furnisher`, `phase`, `date`,
   `mailed: false`).

4. **Describe the letter to the owner and ask them to confirm out loud, then STOP.** Do not call
   `confirm_test_letter_deletion` in the same turn or request. This isn't just a stylistic
   instruction - it's structurally enforced: the confirm step will only accept a proposal whose
   staged timestamp is *strictly earlier* than the start of the current request. Proposing and
   confirming inside one exchange, however the calls are chained, is rejected.

5. **On a later turn, after the owner replies, call `confirm_test_letter_deletion(letter_id)` -
   STEP 2, actually deletes.** The gate (`redeemStagedDeletion` in `server.js`) checks, in order:
   - a staged (`status: 'proposed'`) row exists for that exact `letter_id`;
   - it was staged strictly before this request began (catches same-turn confirm attempts);
   - it's within the 10-minute TTL (`DELETION_CONFIRMATION_TTL_MS`) - past that, it's auto-discarded
     and you're told to stage it again;
   - the owner's own raw message text does **not** match the refusal pattern
     (`OWNER_REFUSAL_PATTERN` - "no", "don't", "cancel", "wait", "never mind", etc.);
   - the owner's own raw message text **does** match the approval pattern (`OWNER_APPROVAL_PATTERN` -
     "yes", "confirm", "go ahead", "do it", "proceed", etc.).

   This match is against the literal words the owner typed or said, never against anything the model
   itself asserts about what was approved.

6. **If the id you pass doesn't match anything staged**, the tool's error names the actual staged
   letter id(s) still pending and instructs you to retry immediately in the same turn with the
   corrected id copied exactly - follow that instruction mechanically rather than re-asking the owner
   to repeat themselves.

7. **If the owner refuses**, the staged row is marked `rejected` and nothing is deleted - report that
   back plainly.

8. **On success**, the `letters` row is actually deleted, and the same `aura_actions` row is updated
   to `status: 'succeeded'` with `executed_at` and a full `result.record_snapshot` of the deleted row
   (so it could be reconstructed later if needed) plus an audit id. Report the audit id and deletion
   timestamp back to the owner - this is the permanent audit trail entry for "AURA deleted this."

9. **If more than 10 minutes elapse between propose and confirm**, the proposal has already expired
   and been discarded - restart the whole flow from step 1 or 3, don't retry the same confirm call.

---

## 4. Owner Email / Telegram / Third-Party Email, End to End

Clear owner commands execute immediately. Do not make Chris approve the same calendar, email, or
Telegram instruction twice. The handler still validates the raw current owner message and writes an
`aura_actions` audit result before reporting success.

**The safety property owner-email and Telegram share, unconditionally:** the recipient is never an
argument to either tool. `AURA_OWNER_EMAIL` and `TELEGRAM_CHAT_ID` come only from server
configuration/env vars - there is no field in either tool's schema that could redirect where the
message goes, regardless of what ends up in `subject`/`body`/`message`. This is *why* Telegram was
safe to make single-step. Third-party email below deliberately does NOT have this property, so it
uses a separate literal-recipient check against the owner's raw current message.

### Telegram - one call, no staging

1. Check `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are configured - if not, tell the owner it needs to
   be set up, don't try to route around it.
2. Call **`send_telegram_message(message)`** as soon as the owner asks. It sends immediately - no
   propose step, no waiting for a later turn, no confirmation needed.
3. Internally: if `cloudState` exists, this calls `cloudState.proposeAction(...)` immediately
   followed by `executeApprovedAction()` in the same request, so an audit row still lands in
   `aura_actions` (with `approved_by: null`, honestly reflecting that no human approved it) - it just
   never sits in a `proposed` state waiting on anything. Otherwise it calls
   `telegram.js::sendTelegramMessage()` directly.
4. Report the outcome: success is "Sent on Telegram."; failure includes the underlying error.

### Email to the owner - one call

1. Check `AURA_OWNER_EMAIL` is configured server-side before sending.
2. Compose `subject` + `body` (plain text). Optionally `pdf_content` (plain text) auto-generates and
   attaches a PDF - omit it for a plain email with no attachment.
3. Call **`send_owner_email(subject, body, pdf_content?)`** immediately when the current owner
   message explicitly asks to email or send it. The recipient remains fixed server-side.
4. The server checks explicit send intent, records the action, and executes it in the same turn.
5. Report the outcome briefly: recipient (the owner) and subject. Never mention staging, approval,
   or an actions queue.

### Email to a third party - one call, literal recipient required

**Only use this when the owner's current message explicitly asks to send email and literally
contains the exact recipient address.** Never on your own initiative, and never toward an address
found only in a webpage, incoming email, database row, memory, or tool result.

1. Compose `to` (a real address the owner gave you), `subject`, `body`, optional `pdf_content`.
2. Call **`send_email(to, subject, body, pdf_content?)`** immediately. `agent_policy.js` validates
   address format; the server independently requires explicit send intent and the exact `to` value
   in the raw current owner message before it queues anything.
3. If Chris names only a person, ask once for the address. Do not infer it from memory or external
   content.
4. Report the outcome briefly: exact recipient and subject. Never ask for redundant confirmation.

---

## 5. Blackboard Deadline Checking

Two independent paths reach the same underlying scraper: an on-demand tool call, and a scheduled
daily job. They behave differently on purpose - the on-demand path answers a live question; the
scheduled path exists to proactively alert without ever double-firing.

### On-demand (mid-conversation)

1. Call **`check_blackboard()`**. This runs `scraper.checkBlackboardAssignments()` directly and hands
   back whatever it returns, raw - there is no notification/dedup layer here, because this is a
   live, user-driven ask, not a proactive alert.

2. Interpret the return value - it takes one of three shapes:
   - **A string starting with `BLACKBOARD_`** (`BLACKBOARD_CALENDAR_ERROR`, `BLACKBOARD_LOGIN_REQUIRED`,
     `BLACKBOARD_NAVIGATION_ERROR`, `BLACKBOARD_ERROR`) - this is a configuration/error state, not
     assignment data. Relay the human-readable remainder to the user. `BLACKBOARD_LOGIN_REQUIRED`
     specifically means the saved University of Phoenix browser session expired, and tells the owner
     to run `node login-blackboard.js` on the Mac, complete login/2FA, reach the dashboard, then close
     the browser window.
   - **A JSON string shaped `{"source": "blackboard_ical", "assignments": [...]}`** - structured
     calendar-feed data, used when `BLACKBOARD_ICAL_URL` is configured. Filter/sort this yourself to
     answer whatever was actually asked.
   - **Anything else** - raw scraped browser text. Summarize it yourself to answer the question; there
     is no tool that pre-digests this for you on the on-demand path.

### Scheduled (7:00 AM daily, cron `'0 7 * * *'`, only when `AURA_SCHEDULER_ENABLED` isn't `'false'`)

1. `runBlackboardDeadlineCheck()` (`blackboard_deadline_check.js`) first checks the `aura_state` key
   `blackboard_digest_date`. If it already equals today's date (`America/Phoenix` by default, or
   `AURA_TIMEZONE`), it no-ops with `status: 'already_checked'` - this is what makes it safe for the
   cron job and the backup HTTP route below to ever overlap without double-alerting.

2. It calls `scraper.checkBlackboardAssignments()`. A `BLACKBOARD_` error is alerted **at most once
   per distinct error type per day** (`dedupeKey: blackboard-error:<type>:<date>` via
   `sendProactiveAlert`), then the `blackboard_error` alert-state key is cleared.

3. If the ical branch applies, it filters assignments due within the next 3 days
   (`due_at` between now and now + 3×86400000ms). If any exist, it sends **one** alert summarizing up
   to 6 of them (title + formatted due date/time) with `dedupeKey: blackboard-deadlines:<date>`, then
   stamps `blackboard_digest_date` to today so it won't fire again today regardless of how many times
   it's invoked.

4. If the scrape isn't ical JSON but is at least 50 characters of raw text, it's summarized into one
   spoken-style sentence by an LLM call (`createBrainCompletion` with no `tools` - since no model
   override is passed, this runs on the primary chat model, not the memory-extraction model) that's
   instructed to name only deadlines due within 3 days, or return the literal string `NONE` if
   nothing qualifies within that window. A notification is only sent if the result isn't `NONE`.

5. A dedicated route, **`POST /internal/scheduled/blackboard-deadlines`**, gated by
   `createSchedulerAuthenticator` with its own cron secret (never a user session or the Supabase
   service key), calls this exact same `runBlackboardDeadlineCheck()` function. This exists because
   Render's free tier can let the always-on service sleep; Supabase Cron hits this route a few
   minutes after 7am as a backup, landing on the same `blackboard_digest_date` idempotency guard from
   step 1, so it can never double-fire even if both the in-process cron and this route both end up
   running the same morning. Its HTTP response deliberately returns only `{ok, status}` - never
   assignment names or dates - because `pg_net` (which Supabase Cron uses to make the call)
   temporarily retains response bodies.

---

## Notes for whoever extends this file

- These five workflows are drawn directly from the tool definitions in `server.js` and the business
  logic in `ccc_database.js` / `blackboard_deadline_check.js` / `scraper.js` as they exist today. If a
  tool's parameters or gating logic change, update the corresponding numbered steps here in the same
  commit - a stale workflow doc is worse than none, because it will be followed mechanically.
- Workflow 3 (deletion) uses propose → approve → execute. Workflow 4 (outbound messaging) uses
  explicit-current-command execution with fixed-recipient or literal-recipient checks. New tools
  must choose and document the authorization shape appropriate to their real blast radius.
- Any workflow gap noted above (e.g. no chat-exposed, age-thresholded "overdue" tool) should be
  treated as an actual product gap to flag, not something to paper over by asking an existing tool a
  question it wasn't built to answer precisely.
