# AGENTS.md

Documents every "multi-agent"-shaped piece of this codebase: what's a real, running
process, and what's a registry table with a name and a stated intent but no code
wired to it yet. If you came here looking for a router that dispatches requests to
different AI personas, **it does not exist**. Read this whole document before you
try to add one — the pieces you'd expect to already be there (a tool-list-per-agent,
a persona selector, a task-to-agent assignment) are present as *data shapes* in
Supabase and absent as *behavior* in the JS.

There are exactly two things in this system that resemble "agents":

1. **The `aura_agents` table** — three registered persona rows (`aura_core`,
   `client_operations`, `finance`) with names, instructions, and tool allowlists.
   Nothing in the codebase queries this table at runtime. See [Part 1](#part-1-the-aura_agents-table-a-persona-registry-with-no-router).
2. **`companion_worker.js`** — a real, separate, always-on process on the Mac that
   AURA's cloud instance hands Mac-only work to over a database job queue. This one
   actually runs, actually executes work, and is the closest thing this system has
   to a functioning multi-process agent handoff. See [Part 2](#part-2-the-mac-companion-a-real-second-process).

---

## Part 1: The `aura_agents` table — a persona registry with no router

### What exists

`supabase_aura_brain.sql` defines the table:

```sql
create table if not exists public.aura_agents (
  id text primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  name text not null,
  description text not null,
  instructions text not null,
  allowed_tools jsonb not null default '[]'::jsonb,
  maximum_risk text not null default 'read'
    check (maximum_risk in ('read', 'reversible_write', 'external_action')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

(`supabase_deletion_log.sql` later widens the `maximum_risk` — and the sibling
`aura_actions.risk_level` — check constraint to also allow `destructive_write`.
`external_action` is a defined enum value that nothing in the JS code ever actually
assigns — it's schema headroom, not a used risk tier.)

Three rows are seeded, across the two setup scripts:

| id | name | allowed_tools | maximum_risk |
|---|---|---|---|
| `aura_core` | AURA | `list_deletable_test_letters`, `propose_test_letter_deletion`, `confirm_test_letter_deletion` | `destructive_write` |
| `client_operations` | Client Operations Agent | `get_client_snapshot`, `get_client_current_phase`, `query_database_table`, `count_database_rows` | `read` |
| `finance` | Finance Agent | `calculate_financial_metrics`, `get_outstanding_balances`, `query_database_table`, `count_database_rows` | `read` |

`client_operations` and `finance` are described (in `supabase_aura_brain.sql`'s
comments) as read-only auditors: the client-ops persona "audits client progress,
phases, missing records, and stalled workflows" and "never modif[ies] client
records"; the finance persona "reconciles collections, recurring revenue, balances,
and commissions" and must "state the accounting definition behind every metric."
These are real, well-considered personas — on paper.

### What actually happens at runtime

Nothing reads this table. A repo-wide search for any JS reference to
`allowed_tools`, `maximum_risk`, or a Supabase query against `aura_agents` comes back
empty:

```
$ grep -rn "allowed_tools\|maximum_risk\|from('aura_agents')" --include="*.js" .
(no matches outside node_modules)
```

There is exactly one live model loop, defined by the single flat `tools` array in
`server.js` (~line 664 onward) and the single `handleToolCall` dispatcher. Every
request — whether it's about a client's phase, a finance metric, or sending an
email — goes to the same GPT-5.6 Sol call with the *same, full* tool list attached,
governed by the *same* system prompt (`AURA_SOUL` + dynamic context). There is no
code path that:

- looks at the user's message and decides "this is a `client_operations` request,"
- swaps in `client_operations`'s `instructions` or `allowed_tools` for that turn, or
- restricts which tools GPT-5.6 Sol can see based on any persona at all.

The only thing that gates which tools can actually run is `agent_policy.js`'s
`TOOL_POLICIES` map — a **flat, persona-agnostic** table of `tool_name -> risk_level`
(`read` / `reversible_write` / `destructive_write` / implicitly `blocked` for
anything not listed). It has no concept of `client_operations` or `finance` at all;
every enabled tool is available to whichever conversation is running, all the time,
subject only to its own risk level and (for reversible/destructive writes) the
propose → approve → execute gate described in `POLICY.md` / the propose-approve-execute
doc. In other words: **the tool-level authorization system that actually runs today
is one flat policy shared by "everyone," not three scoped policies selected per
persona.**

### The `agent_id` stamped on `aura_actions` is a label, not a selection

Every write into `aura_actions` — test-letter deletion staging, owner email staging,
Telegram message staging, memory/profile deletion staging — passes the **literal
string `'aura_core'`** as `agent_id`, hardcoded at each call site
(`ccc_database.js:589`, `ccc_database.js:662`, `server.js:1197`, `server.js:1233`,
`supabase_state_store.js`'s `proposeAction(taskId, agentId, ...)` signature accepts
an `agentId` parameter, but every caller in the codebase passes `'aura_core'`).
Nothing ever passes `'client_operations'` or `'finance'` as an `agent_id`, because
nothing ever decides that one of those personas is "active" for a given request —
there's no such concept.

Worth flagging as an internal inconsistency, not just an absence: `aura_core`'s own
seeded `allowed_tools` (`list_deletable_test_letters`, `propose_test_letter_deletion`,
`confirm_test_letter_deletion`) doesn't even cover the tools actually stamped with
its id in practice — `send_owner_email`, `send_telegram_message`, `delete_memory`,
`delete_profile_entry` are all recorded with `agent_id: 'aura_core'` but none of
them appear in that row's `allowed_tools` array. This is more evidence the column is
descriptive metadata that was never wired to an enforcement point, not a constraint
anything checks.

### `aura_tasks.assigned_agent` — same story

`aura_tasks` has an `assigned_agent` column (FK to `aura_agents.id`), and
`supabase_state_store.js`'s `addTask(title, options)` accepts an
`options.assignedAgent` and writes it through. But the only call site in the
codebase, `server.js`'s handler for the `add_goal` tool
(`cloudState.addTask(args.description)`), never passes `assignedAgent`. Every task
ever created by the running system has `assigned_agent = null`.

### Why this is documented as intent, not fiction

This isn't dead code that should be deleted — it reads as a deliberately-seeded
scaffold for a real routing layer that was designed (three sensible personas, a
risk ceiling per persona, a tool allowlist per persona, a task-assignment column to
hang it off of) before the dispatch logic that would make it live was written. If
you're picking this up to build that dispatch logic, the shape is already right;
you'd be adding the *behavior*, not inventing the *schema*. Concretely, building
real routing would mean at minimum:

1. Deciding, per request or per task, which `aura_agents.id` applies (intent
   classification, an explicit user selection, or an orchestrating "core" agent
   that delegates sub-tasks).
2. Filtering the `tools` array passed to the OpenAI call down to that row's
   `allowed_tools` before the request goes out (today the full list always goes
   out).
3. Making `agent_policy.js`'s authorization check persona-aware — cross-referencing
   `getToolPolicy(name)` against the *active* agent's `allowed_tools`/`maximum_risk`,
   not just the tool's own global risk level.
4. Actually passing the resolved agent id into `proposeAction(taskId, agentId, ...)`
   and `addTask(title, { assignedAgent })` instead of the current hardcoded
   `'aura_core'` / omitted value.

None of that exists yet. Don't describe it as existing in any user-facing or
future-agent-facing documentation — say plainly that `aura_agents` is a registry
with no router, the way this document does.

---

## Part 2: The Mac companion — a real second process

Unlike Part 1, this is a genuinely separate, genuinely running piece of the system.
It is **not an LLM agent** — it has no model call in it anywhere. It's a
deterministic polling worker that exists because only the Mac can drive Apple Mail
and Apple Calendar via AppleScript, and the cloud Render instance can't.

### The two processes

- **Cloud side — `companion_client.js`** (`CompanionClient` class), instantiated in
  `server.js` only when `AURA_RUNTIME === 'cloud'`:

  ```js
  const companionClient = process.env.AURA_RUNTIME === 'cloud'
    ? new CompanionClient({
        url: process.env.SUPABASE_URL,
        serviceKey: process.env.SUPABASE_SERVICE_KEY,
        ownerId: process.env.AURA_OWNER_ID || null,
        targetDevice: process.env.AURA_COMPANION_DEVICE || 'chriss-macbook-pro'
      })
    : null;
  ```

- **Mac side — `companion_worker.js`**, run as the `com.aura.companion` launchd
  service (via `npm run companion`). It polls, claims, executes, and writes back —
  nothing more.

On local Mac runtime, `companionClient` is `null` and `check_email` / `check_calendar`
/ `send_email` call `mac_integration.js` directly — no queue, no second process, no
network hop. The queue only exists to bridge the cloud instance to the Mac.

### The handoff protocol

Everything routes through the `aura_companion_jobs` table
(`target_device`, `capability`, `request` jsonb, `status`, `result` jsonb, `error`,
`expires_at`).

**Enqueue (cloud → table).** `CompanionClient.execute(capability, request, timeoutMs = 75000)`:

1. Inserts a row: `{ owner_id, target_device, capability, request, expires_at: now + timeoutMs + 15s }`, status defaults to `'queued'`.
2. Polls that row every 2 seconds until `status` leaves `'queued'`/`'claimed'`, or
   `timeoutMs` elapses (throws `'The Mac companion did not answer before the
   timeout.'`).
3. On `status === 'succeeded'`, returns `data.result.text`, then immediately
   overwrites `result` to `null` on that row — the payload (which may contain email
   or calendar content) is deleted from the database right after delivery rather
   than lingering. A code comment notes hourly Supabase housekeeping is meant to
   catch results left behind by clients that timed out before this cleanup ran.
4. On `status` in `['failed', 'expired', 'cancelled']`, throws using `data.error`.

**Claim + execute (table → Mac).** `companion_worker.js`'s main `loop()` runs every
`AURA_COMPANION_POLL_MS` (default 5000ms, floor 2000ms):

1. **Maintenance, at most once a minute** (`claimNextJob`'s `lastMaintenanceAt`
   guard): expires any `queued`/`claimed` row past its `expires_at`, and — importantly
   — reclaims jobs stuck in `claimed` for more than 2 minutes back to `queued`
   (`claimed_at` older than `now - 2min` but not yet expired). This is the recovery
   path if the worker process dies mid-job.
2. Selects the single oldest `queued` job for this `owner_id` + `target_device`
   that hasn't expired, and atomically flips it to `claimed` with
   `.eq('status', 'queued')` in the `update` predicate — the standard
   claim-one-row-under-a-WHERE pattern, so two workers (there's only ever one
   today, but the code doesn't assume that) can't double-claim.
3. `processJob(job)` calls `executeCapability(job.capability, job.request)` and
   writes back either `{ status: 'succeeded', result: { text: <string> } }` or
   `{ status: 'failed', error: error.message }`.

**Capabilities implemented in `executeCapability`** (the complete switch statement —
anything else throws `Unsupported Mac companion capability: ...`):

- `check_email` → `mac_integration.getUnreadEmails()`
- `check_calendar` → `mac_integration.getTodaysCalendar()`
- `send_email` → requires `AURA_OWNER_EMAIL` to be set on the Mac companion's own
  environment; if `request.attachment_base64` is present, writes it to
  `os.tmpdir()` under a random name (`aura-<uuid>-<sanitized filename>`), calls
  `mac_integration.sendEmailToOwner(ownerEmail, subject, body, attachmentPath)`,
  then deletes the temp file in a `finally` block regardless of outcome.

### Properties worth relying on when working near this code

- **Polling, not push.** There's no webhook, no WebSocket between the two
  processes — just both sides hitting the same Supabase table on a timer. Latency
  is bounded by `pollInterval` (worker side) plus the 2s client poll, not
  instantaneous.
- **TTL-bounded on both ends.** The client's `timeoutMs` (default 75s) sets
  `expires_at` at enqueue time; the worker's maintenance sweep independently expires
  anything past that same `expires_at`. A job can't sit `queued` forever even if the
  Mac companion is offline — it just eventually times out on the cloud side and
  expires on the (next time the) Mac side runs.
- **One job at a time, oldest first.** `claimNextJob` takes exactly one row
  (`.limit(1)`, `order('created_at', { ascending: true })`) per poll cycle — the
  companion is not concurrent.
- **`target_device` is a real partition key, not decoration.** Both sides key off
  `AURA_COMPANION_DEVICE` (client env var name is the same,
  `AURA_COMPANION_DEVICE`; default on both sides is `'chriss-macbook-pro'`). If you
  ever run a second Mac companion, it needs a distinct `target_device` value or it
  will silently race the first one for the same jobs.
- **No API keys cross the process boundary.** `mac_integration.js`'s
  `runAppleScript()` shells out to `/usr/bin/osascript` with a stripped-down
  environment — the companion worker doesn't hand its Supabase/OpenAI credentials
  to the AppleScript it invokes.

### Where this sits relative to Part 1

`companion_worker.js` is not, and was never meant to be, a row in `aura_agents`. It
has no `instructions`, no LLM call, no persona. It's plumbing: a capability-scoped
RPC mechanism over a database queue, standing in for the request/response a
same-process function call would normally give you, because the two halves of AURA
run on different machines. If a future real agent-routing layer is built on top of
`aura_agents`, the Mac companion would most naturally show up as a **tool
implementation detail** available to whichever persona needs `check_email` /
`check_calendar` / `send_email` — not as a fourth persona row itself.

---

## Quick reference

| Concept | File(s) | Status |
|---|---|---|
| Persona registry (`aura_core`, `client_operations`, `finance`) | `supabase_aura_brain.sql`, `supabase_deletion_log.sql` (table + seed rows only) | Data only — no JS reads it |
| Tool-level authorization (the thing that actually gates tool calls) | `agent_policy.js` (`TOOL_POLICIES`, `getToolPolicy`, `validateToolArguments`) | Live, flat, persona-agnostic |
| Task-to-agent assignment column | `aura_tasks.assigned_agent`, `supabase_state_store.js`'s `addTask` | Column exists; always written `null` in practice |
| Action-to-agent attribution column | `aura_actions.agent_id`, `supabase_state_store.js`'s `proposeAction` | Column exists; every call site hardcodes `'aura_core'` |
| Mac capability delegation (cloud → Mac) | `companion_client.js` (`CompanionClient.execute`) | Live |
| Mac capability execution (on the Mac) | `companion_worker.js`, `mac_integration.js` | Live, runs as launchd service `com.aura.companion` |
| Job queue table | `aura_companion_jobs` (see `supabase_aura_brain.sql`) | Live |

## Open questions / needs verification

- Whether `client_operations` and `finance` were ever invoked through any earlier,
  now-removed code path, or whether the rows have been dispatch-less since they
  were first seeded — not verifiable from the current tree; treat them as
  aspirational from day one unless you find evidence otherwise.
- Whether a second Mac (a second `target_device` value) is planned — nothing in
  the current configuration or code suggests one is running today; this needs
  verification with the owner if it becomes relevant.
