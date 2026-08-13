# AGENTS.md

Documents every "multi-agent"-shaped piece of this codebase: the scoped specialist
router inside the one AURA model loop, and the separate deterministic Mac companion
process. The specialist labels are not separate bots or processes; they are
least-privilege lenses selected for one owner turn.

There are two things in this system that resemble "agents":

1. **The `aura_agents` table** — three registered persona rows (`aura_core`,
   `client_operations`, `finance`) with names, instructions, tool allowlists, and
   risk ceilings. `agent_router.js` activates the two read-only specialists inside
   the existing model loop. See [Part 1](#part-1-scoped-specialist-routing).
2. **`companion_worker.js`** — a real, separate, always-on process on the Mac that
   AURA's cloud instance hands Mac-only work to over a database job queue. This one
   actually runs and executes work. See [Part 2](#part-2-the-mac-companion-a-real-second-process).

---

## Part 1: Scoped specialist routing

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
These descriptions now drive the scoped read-only lenses at runtime.

### What happens at runtime

There is still exactly one model loop and one `handleToolCall` dispatcher in
`server.js`. Before each model turn, `agent_router.js` deterministically selects:

- `finance` for finance-only reads such as MRR, collections, payments, invoices,
  outstanding balances, and commissions;
- `client_operations` for client-progress-only reads such as phase, disputes,
  letters, bureau responses, and active-client counts;
- `aura_core` for general conversation, mixed domains, ambiguous follow-ups, and
  every write, external, or destructive request.

Cloud runtime reads the two specialist rows with
`SupabaseStateStore.listAgents()` and caches them for five minutes. Local
runtime uses matching safe defaults. A missing or disabled specialist falls back
to Core. The selected specialist's instructions are appended as a trusted scoped
lens; AURA's base identity and voice never change.

Authorization is layered:

1. `turn_context.js` drops irrelevant schemas for latency.
2. `filterToolsForAgent()` restricts the schemas sent to the model to the active
   specialist's `allowed_tools`.
3. `agent_policy.js` validates the global tool policy and arguments.
4. `assertAgentCanUseTool()` re-checks the active allowlist and `maximum_risk` in
   `handleToolCall`, so a fabricated or recovered tool call cannot bypass routing.

The live reply gate also catches generic false denials such as "not available in
this chat" and can reintroduce a read-only tool omitted by the latency router. A
recovered read is mandatory; an actual tool failure may be reported afterward.
Writes/actions are eligible for correction only when the normal router already
offered them, and all execution-time authorization still applies. `search_web`
stays in the main loop because its public-input screen, quota, and private-data
boundary must run there; explicit public lookups force that tool on round zero.

Specialists are read-only. They never execute actions or create tasks. Core writes
chat-created goals and Executive Loop commitments with
`assigned_agent = 'aura_core'`, and stamps the resolved Core id on audited actions.
Core also owns durable goal plans in `aura_tasks.input.goal_plan`: `set_goal_plan`
atomically creates or revises the definition of done and ordered steps,
`update_goal_step` records proven progress, and `goal_plans.js` deterministically
selects one next action. Stored plan text is inert and never authorizes the
external action it describes.
Assistant-message `brain.agent` metadata records which lens answered each model
turn. New turns also record the requested/selected lens, registry outcome and
resolution time, response-ready timing, model, reasoning effort, and tool
success evidence. Tool evidence includes execution duration and round number;
`brain.timing.model_rounds` records duration, first-delta timing, fixed phase,
round, and model id. `GET /api/agents/telemetry` aggregates those fields without
returning owner text, model input, tool arguments, or tool results. It reports
per-agent volume/latency, per-tool and per-model-phase latency, fallbacks,
failures, and any specialist evidence outside the built-in read-only allowlist.
Fewer than 20 organic specialist turns is explicitly
`insufficient_specialist_data`; telemetry never authorizes write expansion on
its own.

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
run on different machines. It remains a **tool implementation detail** used by
Core, not a fourth persona row. The current read-only specialists do not expose
Mac companion tools.

---

## Quick reference

| Concept | File(s) | Status |
|---|---|---|
| Persona registry (`aura_core`, `client_operations`, `finance`) | `supabase_aura_brain.sql`, `supabase_deletion_log.sql`, `supabase_state_store.js` | Live for specialist configuration |
| Turn router + specialist enforcement | `agent_router.js`, `server.js` | Live; deterministic, one model loop, Core fallback |
| Specialist routing telemetry | `agent_telemetry.js`, `server.js`, assistant `brain` metadata | Read-only; authenticated at `GET /api/agents/telemetry` |
| Global tool authorization | `agent_policy.js` | Live; composed with specialist allowlist/risk checks |
| Task-to-agent assignment | `aura_tasks.assigned_agent`, `supabase_state_store.js` | Core tasks are attributed; specialists are read-only |
| Goal plan ledger + next-action selection | `goal_plans.js`, `aura_tasks.input.goal_plan`, `server.js` | Core-only internal planning; read at `GET /api/goals/plans` |
| Action-to-agent attribution | `aura_actions.agent_id`, `supabase_state_store.js` | Resolved active Core id is stamped by the tool handler |
| Mac capability delegation (cloud → Mac) | `companion_client.js` (`CompanionClient.execute`) | Live |
| Mac capability execution (on the Mac) | `companion_worker.js`, `mac_integration.js` | Live, runs as launchd service `com.aura.companion` |
| Job queue table | `aura_companion_jobs` (see `supabase_aura_brain.sql`) | Live |

## Open questions / needs verification

- Whether future specialists should be allowed reversible writes. The current
  router deliberately hard-falls action-oriented turns back to Core. Review at
  least 20 organic specialist turns in `/api/agents/telemetry` first; a healthy
  read-only baseline still requires manual safety review before any expansion.
- Whether a second Mac (a second `target_device` value) is planned — nothing in
  the current configuration or code suggests one is running today; this needs
  verification with the owner if it becomes relevant.
