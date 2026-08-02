# TOOLS.md — AURA Capability Reference

This is the "what exists and what does it need" document for AURA's codebase
(`/Users/chris/aura-ai`). It catalogs every AI-callable tool the chat brain
(GPT-5.6 Sol, via `/api/chat` in `server.js`) can invoke, the risk tier each is
registered at in `agent_policy.js`, the database tables those tools read and
write, the Mac companion job protocol used for anything only the Mac can do,
and the environment variables each capability needs configured before it will
work.

It does not explain *how* to use a tool conversationally (see `SKILL.md`) or
*why* the propose/approve/execute boundaries exist (see `POLICY.md`). It is a
reference, organized for someone who needs to know exactly what a tool touches
and what config it depends on.

Tool definitions (name/description/JSON-schema parameters) live in the `tools`
array in `server.js` (~line 664 onward). Risk-tier registration and argument
validation live in `agent_policy.js`'s `TOOL_POLICIES` map. Execution logic for
every tool lives in `handleToolCall()` in `server.js`. A tool not present in
`TOOL_POLICIES` is implicitly `'blocked'` (`getToolPolicy()` returns
`'blocked'` for any unrecognized name, and `parseAndAuthorizeToolCall()`
throws before the tool ever runs).

---

## 1. Risk tiers

`agent_policy.js` defines four tiers, matching the `risk_level` check
constraint on `aura_actions` (`read`, `reversible_write`, `external_action`,
`destructive_write` — see §4).

| Tier | Meaning | Gate |
|---|---|---|
| `read` | No state change. Safe to call freely, no approval needed. | None |
| `reversible_write` | Writes something, but the write is either non-destructive (a goal, a finance log, a memory) or is itself only a *staging* step that changes nothing observable until a paired destructive/external step runs. | None (called directly) |
| `destructive_write` | Permanently deletes data, or sends something externally to a recipient that is fixed server-side (owner email, Telegram) and so cannot be misdirected. | Requires the propose → approve → execute pattern — see §3 (Telegram excepted, see its own tool entry) |
| `external_action` | Sends something externally to a recipient that is a real tool argument, not fixed server config — currently just `confirm_email` (arbitrary-recipient email). The recipient itself has no structural guarantee, so this tier leans entirely on the propose → approve → execute gate rather than on top of it. | Requires the propose → approve → execute pattern — see §3 |

`validateToolArguments()` (also in `agent_policy.js`) applies per-tool
argument shape/length checks (e.g. table names must match
`^[a-zA-Z_][a-zA-Z0-9_]*$`, `action_id` must look like a UUID, search queries
are scanned against `SEARCH_SECRET_PATTERNS` to reject anything that looks
like a leaked credential) before a tool is ever executed.

---

## 2. Tool catalog, by risk tier

Unless noted, "arguments" are exactly the JSON-schema `parameters` the model
sees in the `tools` array; "underlying tables" are what the executor in
`handleToolCall()` actually touches.

### 2.1 `read` tools

| Tool | Purpose | Key arguments | Underlying data / system |
|---|---|---|---|
| `list_database_tables` | Lists every table/view in the Supabase public schema. | none | Supabase RPC `aura_list_tables()` (see `supabase_setup.sql`) |
| `get_table_schema` | Returns column names + types for one table. | `table_name` | Supabase RPC `aura_table_schema(p_table_name)` |
| `query_database_table` | Generic filtered read of any table (with truncation warning if more rows matched than were returned). | `table_name`, `limit` (default 200, capped 200 by `agent_policy.js`), `order_by`, `order_direction`, `filters[]` (`column`, `value`, `op` — one of `eq`, `match`, `is_null`, `not_null`, `gt`, `gte`, `lt`, `lte`) | Any Supabase table, via `ccc_database.js::queryTable()` |
| `count_database_rows` | Exact row count for a filter, without returning rows — the only correct way to answer "how many…" questions. | `table_name`, `filters[]` | `ccc_database.js::countRows()` |
| `get_outstanding_balances` | Lists every CCC client with money still owed, reading inside the nested ledger JSON column that plain filters can't reach. | none | `clients` table (`name`, `billing_status`, `ledger` jsonb array) |
| `calculate_financial_metrics` | Computes MRR, 30-day collected, outstanding total, lifetime revenue, commission owed. | none | `clients` table (`billing_status`, `billing_type`, `billing_tier`, `ledger`, `referral_fee`, `commission_paid`) |
| `get_client_snapshot` | One deterministic client summary: status, billing, current phase, recent letters, outstanding ledger entries. Fuzzy name matching tolerates punctuation, missing middle names, and speech-transcription errors. | `name` | `clients` + `letters` tables, via `ccc_database.js::getClientSnapshot()` / `findClientsByName()` |
| `get_client_current_phase` | A named client's current phase, sourced from their most recent letter batch, with the evidence record attached. | `name` | `clients` + `letters` tables, via `getClientCurrentPhase()` |
| `check_email` | Reads the most recent unread emails (sender, subject, snippet). | none | Direct Gmail/Outlook (`email_provider.js`) if `EMAIL_PROVIDER` is configured, else Mac companion job `check_email`, else direct `mac_integration.js` call on local runtime |
| `check_calendar` | Reads upcoming events (about a week ahead on iCal). Read-only. | none | Private iCal feed (`CALENDAR_ICAL_URL` / `GOOGLE_CALENDAR_ICAL_URL`) via `calendar_feed.js` when set — cloud-capable, no Mac; else Mac companion job `check_calendar`, else local `mac_integration.js` |
| `get_goals` | Retrieves current (non-completed) goals. | none | SQLite `goals` table locally, or `aura_tasks` via `cloudState.listTasks()` in cloud mode |
| `query_finances` | Recent expense/income log entries. | `limit` | SQLite `finances` table (local-only; throws if no SQLite `db`, i.e. always cloud-unsupported today) |
| `check_blackboard` | Scrapes/reads upcoming Blackboard assignment deadlines. | none | `scraper.js::checkBlackboardAssignments()` — see §5 for the two code paths |
| `search_web` | Live public web search + sourced answer, for public information only — never for private CCC records. Rate-limited to 2 attempts per chat turn and gated so it cannot be mixed with private-data tool calls in the same round (privacy boundary enforced in `/api/chat`). | `query` | OpenAI Responses API `web_search` tool via `web_search.js::createOpenAIWebSearch()`; daily quota enforced by `createDailyWebSearchLimiter()` against `aura_state` key `web_search_daily_usage` |
| `list_deletable_test_letters` | Lists unmailed letters whose client name AND furnisher both match the test-record pattern — the only letters eligible for deletion. | none | `letters` table, via `ccc_database.js::listDeletableTestLetters()` (pattern: `/\b(test|delete me|dummy|sample)\b/i`) |
| `list_pending_owner_actions` | Lists staged-but-unapproved emails and calendar events with their `action_id`, so AURA can recover an id that fell out of context instead of guessing (Telegram is never staged, so it never appears here). | none | `aura_actions` where `status = 'proposed'` and `tool_name` in `send_owner_email`/`send_email`/`create_calendar_event`, via `cloudState.listPendingActions()` |

### 2.2 `reversible_write` tools

| Tool | Purpose | Key arguments | Underlying data |
|---|---|---|---|
| `add_goal` | Adds a goal to the tracker. | `description` | SQLite `goals` table, or `aura_tasks` via `cloudState.addTask()` |
| `update_goal_status` | Updates a goal's status (`pending`/`active`/`paused`/`completed`/`dropped`, mapped to `aura_tasks.status` values `pending`/`running`/`blocked`/`completed`/`cancelled` in cloud mode). | `id` (int or UUID), `status` | SQLite `goals`, or `aura_tasks` via `cloudState.updateTaskStatus()` |
| `log_finance` | Logs an expense (negative) or income (positive) entry. | `amount` (≤ 100,000,000 in magnitude), `category`, `description` | SQLite `finances` table (local-only) |
| `save_semantic_memory` | Saves a fact/preference/event for long-term semantic recall. | `fact` | `aura_memories` (cloud) or local `MemoryStore`, via `MemoryV2.learnFromUserMessage()` |
| `propose_test_letter_deletion` | **Step 1 of 2** for deleting a test letter. Re-validates eligibility and *stages* the deletion; deletes nothing. | `letter_id` | Inserts a `proposed` row into `aura_actions` (`tool_name: 'confirm_test_letter_deletion'`) |
| `propose_owner_email` | **Step 1 of 2** for emailing the owner. Stages subject/body/optional PDF content; sends nothing. | `subject`, `body`, `pdf_content` (optional) | Inserts a `proposed` row into `aura_actions` (`tool_name: 'send_owner_email'`) via `cloudState.proposeAction()` |
| `propose_email` | **Step 1 of 2** for emailing anyone OTHER than the owner - only used when the owner explicitly names a recipient. Stages `to`/subject/body/optional PDF content; sends nothing. `to` is validated as a plausible email address by `agent_policy.js` before staging. | `to`, `subject`, `body`, `pdf_content` (optional) | Inserts a `proposed` row into `aura_actions` (`tool_name: 'send_email'`, `risk_level: 'external_action'`) via `cloudState.proposeAction()` |
| `propose_calendar_event` | **Step 1 of 2** for creating a Google Calendar event (optional attendees → invitations). Stages the event; creates nothing until confirm. | `summary`, `start`, `end?`, `duration_minutes?`, `description?`, `location?`, `attendees[]?`, `time_zone?` | Inserts a `proposed` row into `aura_actions` (`tool_name: 'create_calendar_event'`, `risk_level: 'external_action'`) via `cloudState.proposeAction()`; payload validated by `google_calendar.js::buildGoogleCalendarEvent()` |

`send_telegram_message` is NOT a propose/confirm pair - see the `read`/single-call
notes below. It was originally built as a two-step `propose_telegram_message`/
`confirm_telegram_message` pattern identical to email, then deliberately
collapsed to one immediate call at the owner's request: the recipient is fixed
from config either way, so a confirmation step was protecting against nothing
that Telegram-specific staging didn't already prevent by construction. Email
kept the two-step version because it can carry a generated PDF attachment.

Note the comment in `agent_policy.js`: staging a deletion or a message
"changes nothing on its own" — it is registered `reversible_write` precisely
*because* it has no observable effect until the paired `destructive_write`
confirm tool runs.

### 2.3 `destructive_write` tools

Every tool in this tier is a "step 2" confirm tool. Each is gated by the
propose → approve → execute pattern described in §3 — none of them execute
purely because the model called them; each independently re-verifies staging,
turn-passage, and the owner's own words before doing anything irreversible.

| Tool | Purpose | Key arguments | Effect when redeemed |
|---|---|---|---|
| `confirm_test_letter_deletion` | **Step 2.** Permanently deletes a staged test letter. | `letter_id` | `DELETE` from `letters` table; full row snapshot retained in `aura_actions.result` for reconstruction (`ccc_database.js::deleteTestLetter()`) |
| `confirm_owner_email` | **Step 2.** Actually sends a staged email to the owner. | `action_id` | Dispatched by `executeApprovedAction()` → `companionClient.execute('send_email', …)` (cloud) or `mac.sendEmailToOwner()` (local) — see §5 |
| `send_telegram_message` | Sends a Telegram message to the owner immediately - no propose/confirm pair, listed here only because it shares the `destructive_write` tier label for audit-honesty (an unsendable message is unrecoverable), not because it goes through the gate. Calls `cloudState.proposeAction()` immediately followed by `executeApprovedAction()` in the same request (so the audit row still lands in `aura_actions`, with `approved_by: null` - accurately reflecting that no human approval step occurred) when `cloudState` exists, or `telegram.js::sendTelegramMessage()` directly otherwise. | `message` | Sends immediately via `telegram.js::sendTelegramMessage()` |

### 2.4 `external_action` tools

| Tool | Purpose | Key arguments | Effect when redeemed |
|---|---|---|---|
| `confirm_email` | **Step 2.** Actually sends a staged email to an arbitrary, owner-approved recipient. Registered `external_action` rather than `destructive_write` because the recipient is a real tool argument here, not fixed server config - there is no structural guarantee behind this one, only the propose/confirm gate itself. Same re-verification (staged, turn-passage, owner's own words) as every other confirm tool. | `action_id` | Dispatched by `executeApprovedAction()` → `companionClient.execute('send_email_to_recipient', …)` (cloud) or `mac.sendEmailToOwner(args.to, …)` (local) — see §5 |
| `confirm_calendar_event` | **Step 2.** Creates the staged Google Calendar event (and sends invitations when attendees were staged). Same propose/confirm gate as `confirm_email`. | `action_id` | `executeApprovedAction()` → `google_calendar.js::createGoogleCalendarEvent()` via Calendar API `events.insert` (`sendUpdates=all` when attendees present) |

Two additional `destructive_write` actions exist in the **same** `aura_actions`
approval queue but are staged from HTTP routes rather than chat tools (no
`tools[]` entry — the owner triggers these from the UI, not by asking AURA):

| `tool_name` in `aura_actions` | Staged by | Executed by |
|---|---|---|
| `delete_memory` | `DELETE /api/memories/:id` (cloud mode only) | `executeApprovedAction()` → `activeMemory.forget(memory_id)` |
| `delete_profile_entry` | `DELETE /api/profile/:key` (cloud mode only) | `executeApprovedAction()` → removes the entry from `aura_state` key `owner_profile_v1` |

In local/no-Supabase mode (no `cloudState`) these two routes delete
immediately instead of staging — there is no approval queue to stage into,
and it's treated as lower-stakes single-user local dev.

`executeApprovedAction()` in `server.js` is the single dispatch point for
every approved `aura_actions` row, keyed on `tool_name`. Any `tool_name` it
doesn't recognize is returned unexecuted (`return action;`) rather than
guessed at — nothing runs without an explicit handler.

---

## 3. The propose → approve → execute pattern (mechanics, not rationale)

Two independent implementations exist, both ultimately writing to
`aura_actions`:

1. **Test-letter deletion** — bespoke staging in `ccc_database.js`
   (`stageTestLetterDeletion`, `findStagedDeletion`, `discardStagedDeletion`),
   redeemed by `redeemStagedDeletion()` in `server.js`.
2. **Owner email / Telegram** — generic staging via
   `cloudState.proposeAction()` / `cloudState.listPendingActions()` /
   `cloudState.decideAction()` (`supabase_state_store.js`), redeemed by
   `redeemPendingAction()` in `server.js`. This is the same queue backing the
   HTTP routes `GET /api/actions/pending`, `POST /api/actions/:id/approve`,
   `POST /api/actions/:id/reject` — a chat-driven confirmation goes through
   the identical `decideAction()` call the "click approve" button uses, with
   an added voice-turn gate in front of it.

Both redemption functions require, in order:

1. **A later turn.** The staged row's `created_at` (or, for letters, the
   `proposed_at_ms` stashed in `aura_actions.arguments`) must be *earlier*
   than the timestamp the current HTTP request started
   (`requestStartedAtMs`). This is a timestamp comparison, not a counter, so
   it survives process restarts — a proposal and its confirmation can never
   land in the same `/api/chat` request no matter how the model chains tool
   calls.
2. **Not expired.** `DELETION_CONFIRMATION_TTL_MS` = 10 minutes
   (`10 * 60 * 1000`). A stale proposal is discarded (`status: 'rejected'`)
   and must be re-staged.
3. **The owner's own literal words.** `options.userInstruction` (the raw text
   of the current `/api/chat` request body) is tested against
   `OWNER_APPROVAL_PATTERN` (`/\b(yes|yeah|yep|yup|confirm|confirmed|...|go
   ahead|do it|delete it|proceed|permission granted)\b/i`) and
   `OWNER_REFUSAL_PATTERN` (`/\b(no|nope|don'?t|do not|cancel|stop|wait|hold
   off|never ?mind|not yet)\b/i`). This check runs against what the owner
   actually typed/said — never against anything the model claims — so a
   self-convinced model cannot approve its own action.

Only when all three hold does execution proceed: the letter deletion path
calls `ccc.deleteTestLetter()` directly; the generic path calls
`cloudState.decideAction(actionId, true)` then `executeApprovedAction()`.

---

## 4. Database schema (grounding reference)

Schema source files: `supabase_aura_brain.sql` (core tables + RLS),
`supabase_deletion_log.sql` (adds the `destructive_write` risk tier and
registers the `aura_core` agent), `supabase_setup.sql` (the two
introspection RPCs used by `list_database_tables`/`get_table_schema`),
`supabase_free_scheduler.sql` (pg_cron + pg_net wiring for the Blackboard
check, run entirely inside Supabase — see §6). All tables live under RLS with
an `"owner access"` policy (`owner_id = auth.uid()`); the app itself connects
with the Supabase **service role** key, which bypasses RLS by design.

| Table | Key columns | Notes |
|---|---|---|
| `aura_conversations` | `id`, `owner_id`, `title`, `summary` (rolling continuity text), `metadata` jsonb | Exactly one live row in the whole system today (`owner_id 77fd9939-c522-47a2-b81f-9866399ad58c`) — local and cloud share it |
| `aura_messages` | `id` (bigint identity), `conversation_id`, `owner_id`, `role` (`system`/`user`/`assistant`/`tool`), `content`, `metadata` jsonb, `created_at` | |
| `aura_memories` | `id`, `owner_id`, `content`, `kind`, `source`, `confidence` (0–1), `sensitivity`, `embedding` jsonb, `superseded_by`, `expires_at` | Unique index on `(owner_id, lower(content))` where `superseded_by is null`. `kind` values used by `memory_v2.js`: `identity`, `relationship`, `communication`, `preference`, `pronunciation`, `business_rule`, `durable_fact` |
| `aura_notifications` | `id`, `owner_id`, `text`, `category`, `urgency` (`low`/`normal`/`high`/`critical`), `dedupe_key`, `metadata` jsonb, `delivered_at`, `acknowledged_at` | Unique on `(owner_id, dedupe_key)` where not null — prevents duplicate proactive alerts |
| `aura_state` | `owner_id`, `key`, `value` jsonb, `updated_at` | Primary key `(owner_id, key)`. Known keys: `owner_profile_v1` (pinned owner profile, entries keyed e.g. `people.taylor`, `communication.generic_signoff`, `pronunciation.<term>`, each `{kind, value, pinned, source, confidence, instruction}`), `web_search_daily_usage`, `blackboard_digest_date`, `blackboard_error`, `overdue_clients`, `financial_metrics` |
| `aura_agents` | `id` (text, e.g. `aura_core`, `client_operations`, `finance`), `name`, `description`, `instructions`, `allowed_tools` jsonb array, `maximum_risk`, `enabled` | Seeded rows: `client_operations` (read-only client audits), `finance` (read-only financial reconciliation), `aura_core` (added by `supabase_deletion_log.sql`, `maximum_risk: 'destructive_write'`, `allowed_tools` limited to the three test-letter-deletion tools) |
| `aura_tasks` | `id`, `owner_id`, `parent_task_id`, `assigned_agent`, `title`, `description`, `status` (`pending`/`planning`/`awaiting_approval`/`running`/`blocked`/`completed`/`failed`/`cancelled`), `priority`, `due_at`, `input`/`evidence`/`result` jsonb, `error` | Backs `get_goals`/`add_goal`/`update_goal_status` in cloud mode |
| `aura_actions` | `id`, `owner_id`, `task_id`, `agent_id`, `tool_name`, `arguments` jsonb, `risk_level` (`read`/`reversible_write`/`external_action`/`destructive_write`), `status` (`proposed`/`approved`/`rejected`/`executing`/`succeeded`/`failed`/`expired`/`cancelled`), `requires_approval`, `approved_by`, `approved_at`, `result`, `error`, `created_at`, `executed_at` | The generic propose→approve→execute audit trail — see §3 |
| `aura_companion_jobs` | `id`, `owner_id`, `target_device`, `capability`, `request` jsonb, `status` (`queued`/`claimed`/`succeeded`/`failed`/`expired`/`cancelled`), `claimed_at`, `completed_at`, `expires_at` (defaults `now() + 15 min`), `result` jsonb, `error` | The cloud-to-Mac job queue — see §5 |
| CCC business tables | `clients` (`name`, `status`, `billing_status`, `billing_type`, `billing_tier`, `ledger` jsonb array of `{amount, status, description, date/due_date/created_at, paid_at}`, `referral_fee`, `commission_paid`), `letters` (`id`, `client_id`, `client_name`, `phase`, `furnisher`, `mailed_date`, `saved_at`, `date`), plus `client_accounts`, `leads`, and others | Accessed only through the AI tools above (`list_database_tables`/`get_table_schema`/`query_database_table`/`count_database_rows` for generic reads, the dedicated client/finance tools for anything ledger-shaped) — never raw SQL from the model. Exact full column list for tables beyond `clients`/`letters` needs verification directly against Supabase; it is not fully enumerated in this repo's SQL files. |

Local-only SQLite (`aura.db`, used when `AURA_STATE_BACKEND` ≠ `supabase`):
`memory` (id, role, content, timestamp), `goals` (id, description, status,
created_at), `finances` (id, amount, category, description, date),
`alert_state` (key, value — mirrors `aura_state`), `notifications` (mirrors
`aura_notifications`, plus a `dedupe_key` unique index). These exist so the
Mac-local dev/prod runtime can operate without Supabase configured at all;
`cloudState` (a `SupabaseStateStore`) is the cloud/Supabase-backed
implementation of the same surface.

---

## 5. Mac companion job protocol

For anything only the physical Mac can do — Apple Mail, Apple Calendar,
sending mail through the Mac's own Mail.app identity — cloud runtime cannot
act directly and instead queues a job for the Mac to pick up.

**Shape of a job row in `aura_companion_jobs`:**
```
{
  owner_id: <uuid>,
  target_device: 'chriss-macbook-pro',   // AURA_COMPANION_DEVICE
  capability: 'check_email' | 'check_calendar' | 'send_email',
  request: { ... capability-specific payload ... },
  status: 'queued' -> 'claimed' -> 'succeeded' | 'failed' | 'expired' | 'cancelled',
  claimed_at, completed_at, expires_at,
  result: { text: '<capability result string>' } | null,
  error: '<message>' | null
}
```

**Capability payloads:**

| Capability | `request` shape | `result.text` shape |
|---|---|---|
| `check_email` | `{}` | Formatted string of up to 10 unread messages: `Received / From / Subject / Content Snippet` blocks |
| `check_calendar` | `{}` | Formatted string of today's + tomorrow's event summaries, or "No events scheduled for today." |
| `send_email` | `{ subject, body, attachment_base64?, attachment_filename? }` | `"sent"` |

**Producer side — `companion_client.js` (`CompanionClient`, used only when
`AURA_RUNTIME=cloud`):** `execute(capability, request, timeoutMs=75000)`
inserts the job row (`expires_at = now + timeoutMs + 15s`), then polls every
2 seconds for `status`. On `succeeded` it reads `result.text`, immediately
clears the stored `result` back to `null` (`UPDATE ... SET result = null`) so
Mail/Calendar content doesn't linger in the row after delivery, and returns
the text. On `failed`/`expired`/`cancelled` it throws `data.error` or a
generic `"Mac job <status>"`. If the deadline passes with no terminal status,
it throws `"The Mac companion did not answer before the timeout."`.

**Consumer side — `companion_worker.js` (runs on the Mac as the launchd
service `com.aura.companion`):** polls every `AURA_COMPANION_POLL_MS`
(default 5000ms, floor 2000ms) for `queued` jobs matching its own
`target_device`, claims exactly one at a time
(`status: 'queued' -> 'claimed'`, guarded by a conditional update so two
workers can't double-claim), executes it via `mac_integration.js`, then
writes back `succeeded`/`result` or `failed`/`error`. Every 60 seconds it also
runs simple housekeeping: expire `queued`/`claimed` jobs whose `expires_at`
has passed, and reclaim jobs stuck in `claimed` for over 2 minutes (crashed
mid-job) back to `queued`.

**Execution layer — `mac_integration.js`:** `runAppleScript()` shells out to
`/usr/bin/osascript` with a deliberately stripped environment (only `HOME`,
`USER`, `LOGNAME`, `TMPDIR`, `LANG`, and a fixed `PATH` — no API keys or
tokens from AURA's own process reach the AppleScript child process).
`getUnreadEmails()` / `getTodaysCalendar()` / `sendEmailToOwner(ownerEmail,
subject, body, attachmentPath)` all `tell application "Mail"` / `"Calendar"`.
For `send_email`, if an attachment is present, `companion_worker.js` writes
`attachment_base64` to a random temp filename under the OS temp dir, passes
the path to `sendEmailToOwner`, and deletes the temp file in a `finally`
block regardless of outcome.

**On cloud runtime**, `check_email`/`check_calendar`/`send_email` route
through `CompanionClient` to reach the Mac. **On local Mac runtime**,
`mac_integration.js` is called directly with no queue involved (`server.js`
checks `companionClient` truthiness — it's only constructed when
`AURA_RUNTIME === 'cloud'`).

`check_email` additionally supports a **direct cloud email path**
(`email_provider.js`) that bypasses the Mac entirely when `EMAIL_PROVIDER` is
set to `gmail` or `outlook` with the matching OAuth env vars present — see §6.
Priority in `handleToolCall()`: direct provider first, then companion job,
then direct `mac_integration.js` call.

---

## 6. Environment / configuration requirements, per capability

| Capability | Required env vars | Behavior if missing |
|---|---|---|
| Chat brain | `AI_PROVIDER` (`openai` / `xai` / `deepseek`) + matching key (`OPENAI_API_KEY` / `XAI_API_KEY` / `DEEPSEEK_API_KEY`), `AURA_CHAT_MODEL` (default `grok-4.5` for xai, else `gpt-5.6-sol`), `AURA_REASONING_EFFORT` (OpenAI gpt-5.6 only; forced to `none` when function tools are present — `model_router.js`) | Falls back to a dummy key placeholder; requests fail at the provider |
| Vector memory | `OPENAI_API_KEY` (`text-embedding-3-small`), `AURA_MEMORY_MODEL` (default `gpt-5.6-luna` for extraction/summaries) — always OpenAI, even when chat is xAI/Grok | Semantic recall and Luna extraction unavailable without OpenAI |
| Memory extraction / summarization | `AURA_MEMORY_MODEL` (default `gpt-5.6-luna`), `AURA_SUMMARY_MESSAGE_THRESHOLD` (default 40) | Summaries never regenerate below the threshold |
| Embeddings (memory search) | `OPENAI_API_KEY` | `getEmbedding()` throws; semantic memory falls back to non-embedded storage |
| Voice transcription | `OPENAI_API_KEY` + `AURA_TRANSCRIBE_MODEL` (default `gpt-4o-mini-transcribe`, `/api/transcribe`; falls back to `whisper-1`) | Throws `"OPENAI_API_KEY is required for transcription."` |
| TTS | `CARTESIA_API_KEY` (`/api/tts`, Cartesia `/tts/bytes`, model `AURA_TTS_MODEL` default `sonic-3.5`, sample rate `AURA_TTS_SAMPLE_RATE` default `24000`) | Cartesia API call fails, 500 returned |
| Live web search | `OPENAI_API_KEY`, `OPENAI_WEB_SEARCH_MODEL` (default `gpt-5.4-mini`), `AURA_WEB_SEARCH_CONTEXT` (default `medium`), `AURA_WEB_SEARCH_TIMEOUT_MS` (default 45000), `AURA_WEB_SEARCH_DAILY_LIMIT` (default 25) | Throws `WEB_SEARCH_NOT_CONFIGURED` |
| Supabase-backed state (cloud) | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `AURA_OWNER_ID`, `AURA_STATE_BACKEND=supabase` | Falls back to local SQLite (`aura.db`) + in-process `localProfileStore` |
| Mac companion (cloud → Mac) | `AURA_RUNTIME=cloud`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `AURA_OWNER_ID`, `AURA_COMPANION_DEVICE` (default `chriss-macbook-pro`) | `CompanionClient` is only constructed under `AURA_RUNTIME=cloud`; on local runtime `mac_integration.js` is called directly instead |
| Companion worker (on the Mac) | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `AURA_OWNER_ID`, `AURA_COMPANION_DEVICE`, `AURA_COMPANION_POLL_MS` (default 5000), `AURA_OWNER_EMAIL` (required specifically for `send_email`; NOT required for `send_email_to_recipient`, which reads its address from the job payload instead) | Throws at startup without `AURA_OWNER_ID`; `send_email` throws `"AURA_OWNER_EMAIL is not configured on the Mac companion."` |
| Owner email (send) | `AURA_OWNER_EMAIL` — fixed recipient, **never** a tool argument the model can supply | `propose_owner_email` returns "Email is not configured" without ever staging anything |
| Third-party email (send) | No dedicated env var — reuses whatever Mac Mail / companion path is already configured for owner email; the recipient comes from the staged `to` argument instead of `AURA_OWNER_EMAIL`. | `propose_email` still requires `cloudState` (the approval queue) to stage anything, same as `propose_owner_email` |
| Direct cloud email (bypasses Mac) | `EMAIL_PROVIDER=gmail\|outlook` plus matching OAuth vars: Gmail — `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`; Outlook — `OUTLOOK_TENANT_ID`, `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_REFRESH_TOKEN` | `isDirectEmailConfigured()` returns false; `check_email` falls through to the companion/mac path |
| Google Calendar write | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN` (OAuth scope `calendar.events`); optional `GOOGLE_CALENDAR_ID` (default `primary`). Falls back to `GMAIL_*` if the dedicated vars are unset. | `propose_calendar_event` returns a not-configured message without staging |
| Telegram (send) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — fixed chat id, **never** a tool argument | `send_telegram_message` returns "Telegram is not configured" without sending anything |
| Blackboard — cloud path | `BLACKBOARD_ICAL_URL` (an iCal/webcal feed URL, must resolve to `https://` or `webcal:`; treat as a secret — it is usually a bearer-token URL) | On cloud runtime with no iCal URL set, `check_blackboard` returns `BLACKBOARD_CALENDAR_ERROR: Blackboard calendar access is not configured on the cloud service.` |
| Blackboard — local Mac path | None required beyond a previously-authenticated Puppeteer session (`.browser_data/`, established via `node login-blackboard.js`); optional `AURA_DEBUG_SCRAPES=true` dumps raw scraped text to `scraped_blackboard.txt` | Falls back to `BLACKBOARD_LOGIN_REQUIRED` if the saved session expired |
| Scheduled proactive checks | `AURA_SCHEDULER_ENABLED` (default effectively true — disabled only by literal `'false'`), `AURA_TIMEZONE` (default `America/Phoenix`) | Cron jobs registered in-process are skipped entirely |
| Supabase-side scheduling (Render free-tier workaround) | Supabase Vault secrets `aura_deadline_origin` (HTTPS origin only) and `aura_deadline_cron_secret` (64-char hex, matches `AURA_CRON_SECRET`); `pg_net`, `pg_cron`, `supabase_vault` extensions | `supabase_free_scheduler.sql` migration raises an exception at apply time if either Vault secret is missing/malformed |
| Cron-triggered HTTP routes | `AURA_CRON_SECRET` (64-char hex; validated in `scheduler_auth.js`) — protects `POST /internal/scheduled/blackboard-deadlines` and `POST /internal/scheduled/memory-extraction` | Route returns 503 if unset/invalid, 401 if the header doesn't match |
| Durable memory extraction queue | `cloudState` present (i.e. Supabase state backend); tunables `AURA_MEMORY_WORKER_BATCH_SIZE` (10), `AURA_MEMORY_WORKER_LEASE_MS` (300000), `AURA_MEMORY_WORKER_MAX_ATTEMPTS` (5), `AURA_MEMORY_WORKER_RETRY_BASE_MS` (15000), `AURA_MEMORY_WORKER_RETRY_MAX_MS` (900000), `AURA_MEMORY_WORKER_INTERVAL_MS` (30000) | Falls back to synchronous best-effort `memoryV2.learnFromUserMessage()` fire-and-forget per message |
| Auth | `AURA_ACCESS_TOKEN` (token mode), `AURA_AUTH_MODE` (`token`/`supabase`/`hybrid`/`tailscale`), `AURA_TAILSCALE_LOGIN` + `AURA_PUBLIC_URL` (tailscale mode) | See `authenticate()` in `server.js`; direct localhost on non-cloud runtime always bypasses auth |

---

## 7. Quick index — tool name → risk tier

```
read:
  list_database_tables, get_table_schema, query_database_table,
  count_database_rows, get_outstanding_balances, calculate_financial_metrics,
  get_client_snapshot, get_client_current_phase, check_email, check_calendar,
  get_goals, query_finances, check_blackboard, search_web,
  list_deletable_test_letters, list_pending_owner_actions

reversible_write:
  add_goal, update_goal_status, log_finance, save_semantic_memory,
  propose_test_letter_deletion, propose_owner_email, propose_email,
  propose_calendar_event

destructive_write:
  confirm_test_letter_deletion, confirm_owner_email, send_telegram_message
  (+ delete_memory, delete_profile_entry — staged via HTTP routes, not chat tools)
  # send_telegram_message is tagged destructive_write for audit honesty (an
  # unsendable message) but is NOT gated by the propose/confirm pattern -
  # it sends immediately, since the fixed recipient makes a confirm step
  # redundant. Every other destructive_write tool here IS gated.

external_action:
  confirm_email, confirm_calendar_event
  # Recipient/attendees are real arguments, not fixed server config — safety
  # rests on the propose/confirm gate.

(anything else): blocked
```

This is a direct transcription of `TOOL_POLICIES` in `agent_policy.js` at the
time of writing — treat that file, not this table, as the source of truth if
they ever diverge.
