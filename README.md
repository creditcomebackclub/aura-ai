# AURA

AURA is a local, voice-first personal assistant with long-term memory, proactive
notifications, Apple Mail and Calendar access, Blackboard monitoring, and
business intelligence for Credit Comeback Club. Its Executive Loop monitors
new actionable email, calendar changes, upcoming meetings, due commitments,
and promises the owner makes in sent mail without waiting to be asked.

## Setup

1. Install Node.js 20 or newer and run `npm install`.
2. Copy `.env.example` to `.env` and fill in the required credentials.
3. Run `supabase_setup.sql` once in the Supabase SQL editor.
4. Start AURA with `npm start`.
5. Open `http://localhost:3000`.

Chat can run on OpenAI (`gpt-5.6-sol`), xAI (`grok-4.5` via `AI_PROVIDER=xai`),
or DeepSeek. **Vector memory stays on OpenAI** either way: `text-embedding-3-small`
for semantic recall, and `AURA_MEMORY_MODEL` (default `gpt-5.6-luna`) for
extraction/summaries. Whisper transcription and live `search_web` also stay on
OpenAI. Cartesia provides speech synthesis.

## Phone and LAN access

The recommended Mac-hosted mode uses Tailscale Serve and Tailscale identity:

```bash
tailscale serve --bg http://127.0.0.1:3000
```

Set `AURA_AUTH_MODE=tailscale`, `AURA_PUBLIC_URL` to the generated HTTPS URL,
and `AURA_TAILSCALE_LOGIN` to the owner's Tailscale login. The phone must have
Tailscale connected whenever it opens this private Mac URL. No shared AURA token
is needed in this mode.

`AURA_ACCESS_TOKEN` remains available as a legacy LAN option. The cloud service
uses Supabase Auth instead.

## Privacy and security

- Supabase is accessed only by the server. Never expose its service-role key to
  browser code.
- Tool arguments are validated and tools are classified as read-only,
  reversible writes, or blocked.
- Tool results, emails, webpages, database values, and memories are explicitly
  treated as untrusted data rather than agent instructions.
- Public web searches use a supported provider rather than scraping search-result
  HTML. Search calls have normal OpenAI model and web-tool usage costs.
- Search is capped at two attempts per request, three provider tool calls per
  attempt, and 25 search requests per Phoenix calendar day by default. Override
  the daily cap with `AURA_WEB_SEARCH_DAILY_LIMIT`.
- After web search, the next model pass is tool-free. AURA also refuses to send
  a web search after reading private business, mail, calendar, finance, goal, or
  Blackboard data in the same request.
- The provider receives only the current user request for that search—not query
  text composed from AURA's private memories or prior conversation history.
- Conversation history, structured memories, notifications, goals, and finance
  logs use Supabase when `AURA_STATE_BACKEND=supabase`; otherwise they remain
  local in `aura.db`.
- Raw Blackboard text is not saved unless `AURA_DEBUG_SCRAPES=true`.
- Memory can be inspected with `GET /api/memories`. In cloud mode, deleting a
  memory (`DELETE /api/memories/:id`) or a pinned profile key
  (`DELETE /api/profile/:key`) does not delete immediately - it stages the
  deletion into a pending-actions queue (`GET /api/actions/pending`), which
  only executes once explicitly approved (`POST /api/actions/:id/approve`) or
  discards it if rejected (`POST /api/actions/:id/reject`). Local/no-Supabase
  mode has no approval queue and deletes immediately.
- AURA's core persona and behavioral rules live in `SOUL.md`, loaded once at
  server boot - not inline code or a hot-editable database row, so changes go
  through the same git review and test gate as any other code change.
- Run `npm run memory:view` (or hit the authenticated `GET /api/memory/view`)
  for a plain-English snapshot of everything AURA currently "believes": the
  pinned profile, durable memories, and the rolling conversation summary,
  with a warning if the summary contains a self-capability negation (e.g. a
  claim that she lacks access she actually has). This exists because
  diagnosing a poisoned summary previously required raw Supabase queries.

The existing `semantic_memory.json` file is imported non-destructively into the
structured SQLite memory table at startup.

## Memory v2

AURA keeps an always-loaded owner profile for stable identity facts, people and
relationships, communication preferences, pronunciations, and business rules.
People records can also preserve directly stated aliases, email addresses,
phone numbers, organization/role, preferences, commitments, and recent context.
Later mentions merge into the existing person instead of discarding previously
learned contact details.
Other durable facts remain searchable through hybrid vector and lexical retrieval,
and a bounded always-on MEMORY slice of recent facts is injected every turn.
Conversation continuity is maintained with rolling summaries in Supabase.

## Procedural skills

Reusable workflows live under `skills/bundled/` (seeded CCC runbooks) and
`skills/learned/` (agent-created in local/Mac mode). In cloud mode, learned
skills are instead stored owner-scoped in Supabase `aura_state`, so they survive
Render restarts and redeploys. Each turn gets a name+description index;
full bodies load via `view_skill`. After tool-heavy turns, a background learning
review may pin durable facts or write/patch learned skills (disable with
`AURA_LEARNING_REVIEW=false`).

Reflection batches and counters are durable in Supabase, so AURA can learn from
several experiences even when Render restarts between them. Learned procedures
must include supporting evidence and sufficient confidence. Autonomous changes
enter an inactive candidate lifecycle: a second model call replays the candidate
against at least two sanitized historical scenarios, while deterministic checks
reject credentials, prompt injection, authorization bypasses, self-modification,
and ungated external-action procedures. New skills need an average replay score
of at least `0.75`; patches must also beat the active version by at least `0.05`.
Candidates remain invisible to `list_skills` and `view_skill` until promoted.

Cloud records retain up to 20 candidate, active, retired, rejected, and
rolled-back versions per skill. Two negative owner corrections or three hard
failures within the last five uses automatically restore the previous learned
version, bundled fallback, or disabled state and create a high-urgency learning
notification. Manual `manage_skill` writes require a direct current-turn owner
request. Inspect lifecycle history at authenticated `GET /api/learning/skills`,
or explicitly roll back with `POST /api/learning/skills/:name/rollback` and
`{ "from_version": 3, "reason": "..." }`. See `LEARNING_ROADMAP.md` for the
remaining memory, retrieval, planning, and capability milestones.

When a skill is loaded with `view_skill`, AURA records the exact skill version,
subsequent tool outcomes, and the immediately following owner feedback. Neutral
follow-up turns close automatic attribution so unrelated later corrections do
not contaminate old outcomes. Inspect the authenticated ledger at
`GET /api/learning/outcomes`, view aggregate counts at
`GET /api/learning/summary`, or submit explicit feedback with
`POST /api/learning/outcomes/:id/feedback` using `{ "rating": "positive" |
"negative", "note": "..." }`.

Reflection may also save a notable episode—such as a completed workflow,
decision, correction, or failure and its outcome—without turning that event into
a permanent profile fact. Episodes participate in semantic recall and future
reflection, but remain out of the always-on memory slice. Inspect them at the
authenticated `GET /api/learning/episodes` endpoint.

Repeated episodes can be consolidated into an evidence-backed belief only when
at least two real episode ids support the same statement at 0.75 confidence or
higher. A conflicting statement marks the belief `contested` instead of
overwriting it; relevant contested beliefs are shown to AURA with a requirement
to clarify rather than act on them. Inspect the authenticated ledger at
`GET /api/learning/beliefs`. Resolve a recorded conflict explicitly with
`POST /api/learning/beliefs/:key/resolve` and `{ "statement": "...", "note":
"..." }`; the statement must match the current belief or a recorded alternative.

## Retrieval observability

Semantic recall now uses a transparent combined score: vector similarity, lexical
overlap, named-entity overlap, recency, and memory confidence. Recency and
confidence only refine a memory that already matches; they cannot make an
unrelated memory appear relevant. Every semantic recall writes a bounded,
owner-scoped private trace of the query, memories injected into context, score
components, match reason, source, confidence, and age. Inspect it with
authenticated `GET /api/memory/retrievals`. Use the existing profile and memory
deletion endpoints to correct any influential memory; cloud deletions remain
approval-staged.

AURA extracts durable facts automatically with the configured background model.
These commands are also handled explicitly:

```text
Remember that I prefer meetings at 10 AM.
Forget about my preferred meeting time.
Correction: I prefer meetings at 11 AM.
Pronounce "WK 4" as "week four."
```

Credentials, tokens, passwords, and one-time codes are never eligible for
memory. Inspect the structured profile at `GET /api/profile`, inspect semantic
memories at `GET /api/memories`, or get a combined human-readable view of both
plus the rolling summary with `npm run memory:view` /
`GET /api/memory/view`. Removing a profile entry (`DELETE /api/profile/:key`)
stages a deletion for approval in cloud mode rather than removing it
immediately - see "Privacy and security" above.

Ordinary conversation extraction is queued durably in Supabase and runs after
the chat response is returned. Jobs are keyed to persisted user messages,
leased idempotently, retried with bounded backoff, and resumed whenever the
service wakes. Explicit remember, correct, and forget commands remain
synchronous.

After enabling Memory v2, existing conversations can be scanned once for a
small set of deterministic relationship, communication, and pronunciation
facts without sending the historical transcript to a model:

```bash
npm run backfill:memory-v2
```

## Models

Normal conversation and tool decisions use `AURA_CHAT_MODEL` (default
`grok-4.5` when `AI_PROVIDER=xai`, otherwise `gpt-5.6-sol`). Automatic
durable-fact extraction, rolling summaries, and **vector embeddings** stay on
OpenAI (`AURA_MEMORY_MODEL=gpt-5.6-luna` + `text-embedding-3-small`) so recall
quality does not depend on the chat provider.

## Voice interface

The phone and home-screen interface is text-free. A canvas waveform reacts to
AURA's actual speech through the Web Audio API, with a reduced-motion fallback.
Live-web evidence remains available to AURA for grounded spoken answers, while
the visual surface stays clear on both phone and desktop.

## Notifications

Proactive alerts are persisted before being emitted over WebSockets, so alerts
are not lost merely because the UI is disconnected. Unacknowledged alerts are
available at `GET /api/notifications`; acknowledge one with
`POST /api/notifications/:id/acknowledge`.

The Executive Loop runs every five minutes when `AURA_EXECUTIVE_LOOP` is not
`false`. Its first run baselines the current unread inbox and calendar, so
enabling it does not replay old mail or events. Later runs surface:

- newly actionable or urgent unread email;
- explicit sent-mail promises such as “I'll send the packet by Friday,” captured
  once as an internal task with the stated deadline;
- calendar cancellations and reschedules;
- meeting briefs 8–20 minutes before timed events, including matching unread
  mail, open follow-ups, and verified CCC client phase/billing context when an
  attendee matches a client;
- goal connections, when a new email or calendar invitation involves someone
  tied to an open goal (see "Goal connections" below); and
- due or recently overdue tasks.

Routine email and task alerts are deferred during quiet hours (9:00 PM–7:00 AM
Phoenix by default); urgent email and calendar cancellations still surface.
Configure `AURA_EXECUTIVE_QUIET_START`, `AURA_EXECUTIVE_QUIET_END`,
`AURA_MEETING_BRIEF_MIN_MINUTES`, and `AURA_MEETING_BRIEF_MAX_MINUTES` to tune
the behavior. The protected `POST /internal/scheduled/executive-loop` route can
also trigger an operational run and returns provider counts plus the authenticated
mailbox identity, never message content.

## Goal connections

AURA links inbound signals to the goals they advance. If an open goal reads
"setup partnership with identity iq" and a new email arrives from
`matt@identityiq.com`, she surfaces the connection along with the time actually
free on the calendar:

```text
Goal connection
Matt Rivera emailed you — “Reseller partnership — next steps”.
This lines up with your goal: setup partnership with identity iq.
You're open Thursday, Aug 20 3–5 PM if you want to set up a time.
```

Matching runs in two tiers, cheapest first:

1. **Deterministic.** Goal text and sender identity are reduced to a canonical
   form that ignores case, spacing, punctuation, corporate suffixes,
   subdomains, and TLDs — so "Identity IQ", "identityiq", and `identityiq.com`
   all resolve to the same entity with no model call. Goals dictated in
   lowercase still match, because candidates come from contiguous word runs
   rather than capitalization. Public mailbox domains (Gmail, iCloud, Outlook,
   …) are never treated as an organization.
2. **Semantic.** When tier 1 finds nothing confident, the signal is embedded
   once and compared against cached goal vectors, blended with lexical and
   named-entity overlap through the same scorer used for memory recall
   (`retrieval_scoring.js`). A confident deterministic hit short-circuits before
   any embedding is purchased, so the common case is free.

Goal vectors are cached per goal and only recomputed when the goal's text
changes, using a 256-dimension slice of `text-embedding-3-small`. With no
`OPENAI_API_KEY` — or during a provider outage — tier 1 keeps working on its
own.

Every new human email is checked, not only the ones the urgency classifier
flags: "great meeting you at the conference" advances a partnership without
ever looking actionable. Automated mail is excluded, connections are held
during quiet hours (and re-evaluated afterward rather than dropped), and a
matcher outage retries on the next run instead of silently skipping the signal.

### Linked context

Once a goal matches, the same canonical entities are resolved against the owner
profile's people records and — when an organization surfaces — against CCC
client records, so one alert carries the goal, the contact, and the client's
real standing instead of three disconnected lookups:

```text
Goal connection
Matt Rivera emailed you — “Reseller partnership — next steps”.
This lines up with your goal: setup partnership with identity iq.
Known contact: Matt Rivera — VP Partnerships at Identity IQ.
CCC: Identity IQ — Phase 2 · Active · Current · $1250.00 outstanding.
You're open Thursday, Aug 20 3–5 PM if you want to set up a time.
```

People matching is deterministic only — a fuzzy vector hit on a person is a
misidentification, not a useful recall. An exact address match identifies the
sender ("Known contact"); a shared company domain only places someone at that
organization and is worded as context instead ("Possibly related"), so a note
from a colleague never claims to be from the contact you know. Aliases and
stored addresses are both searchable, and a personal mailbox domain still
cannot link a person even though an exact personal address can.

Linking runs only after a goal has matched — it costs a profile read and at
most two directory lookups, and there is nothing to attach them to otherwise.
A directory outage degrades to the goal connection alone. The ledger records
the resolved names, roles, and balances as labels, not as a copy of the profile
or client database.

### The drafted reply

When a connection comes from email and there is time to offer, AURA also
composes the scheduling reply and parks it in the existing approval queue, so
approving it is the only step left:

```text
Hi Matt,

Thanks for reaching out — happy to find a time to talk.

I'm open Thursday, Aug 20 3–5 PM. Would that work for you?

Best,
Chris
```

The draft is never sent on its own. It enters the same pending-actions queue as
every other staged action (`GET /api/actions/pending`) and only goes out on
`POST /api/actions/:id/approve`, which already knows how to send email.

**The body is built from a fixed template, never generated by a model.** An
inbound email is untrusted input, so asking a model to "reply to this" points a
prompt-injection surface straight at the outbox — the owner would be approving
text the sender partly authored. Everything in the draft comes from trusted
values (the owner's own calendar windows and configured name). The two
untrusted fields are sanitized before use: the sender's display name must pass
a strict name whitelist or the greeting degrades to a bare "Hi,", and the
subject is stripped of newlines so it cannot inject a mail header. The owner's
goal text is deliberately excluded — "setup partnership with identity iq" is a
private note, not something to leak to the counterparty.

No draft is produced for calendar signals, when there is no free time, when the
sender is a no-reply or automated address, or when the sender is the owner.

Approving a draft closes the learning loop: it marks that connection as acted
on, which is the strongest available confirmation the match was right and
requires no separate rating.

### Learning which connections are worth making

Every fired connection is recorded with its full score breakdown, evidence, and
suggested times. Outcomes then tune how eager AURA is, per match class
(`domain`, `organization`, `person`, `phrase`, `semantic`):

- acting on a match, or rating it positive, lowers that class's confidence bar;
- rejecting it, or leaving it unacknowledged for a week, raises it.

Thresholds use Laplace-smoothed precision against a 0.75 target, only move once
a class has at least three resolved observations, and stay clamped to
0.45–0.90 — so one stray rejection cannot silence a whole class, and one class's
history never affects another.

Inspect the ledger and current thresholds at authenticated
`GET /api/goals/matches`, or the indexed goals and their entities at
`GET /api/goals/index`. Record an outcome with
`POST /api/goals/matches/:id/outcome` and `{ "outcome": "acted" | "ignored" }`,
or submit explicit feedback with `POST /api/goals/matches/:id/feedback` and
`{ "rating": "positive" | "negative", "note": "..." }`.

Set `AURA_GOAL_SIGNALS=false` to disable the feature. Suggested times respect
`AURA_BUSINESS_START_HOUR` (default 9) and `AURA_BUSINESS_END_HOUR` (default
17), skip weekends, and are computed from the calendar events the Executive
Loop already fetched — no extra API call. Subject lines are screened for
credentials and one-time codes before anything reaches the ledger.

The Gmail account identity is stored with the durable baseline. Switching OAuth
to a different mailbox automatically resets only the inbox and sent-mail cursors;
calendar and task history stay intact. Incoming mail can alert the owner but can
never create tasks or authorize external actions. Commitment capture reads only
the owner's Sent folder and requires both first-person promise language and a
concrete, deterministically parsed deadline.

## Blackboard

The most reliable unattended option is Blackboard's private external-calendar
subscription. If the Blackboard Calendar settings offer an iCal or "external
calendar subscription" link, store it as `BLACKBOARD_ICAL_URL` in `.env`. Treat
that URL like a password.

When no calendar URL is configured, Mac-hosted AURA can use a persistent browser
session. Cloud AURA fails closed instead of attempting to store or automate a
Blackboard login. Renew an expired local session with:

```bash
node login-blackboard.js
```

Complete login and 2FA, reach the portal dashboard, and close the opened browser.
The browser profile stores session cookies, never the password itself.

## Development

```bash
npm run check
npm test
# With AURA running and configured:
npm run eval
```

The unit suite covers tool authorization and validation, structured owner
profiles, automatic extraction, corrections, forgetting, rolling summaries,
hybrid retrieval, memory deduplication, and graceful embedding outages. The
live evaluation suite checks real model tool selection, business lookup
behavior, and a prompt-injection regression case. Add scenarios to
`eval/cases.json`.

## Automatic Mac service

The local server is installed as the per-user LaunchAgent `com.aura.ai`. It
starts at login and restarts after crashes without an open Terminal window.

```bash
launchctl print gui/$(id -u)/com.aura.ai
launchctl kickstart -k gui/$(id -u)/com.aura.ai
```

Service output is written to `aura-service.log` and
`aura-service-error.log`.

## Cloud brain migration

1. Run `supabase_aura_brain.sql` in the Supabase SQL Editor.
2. Set `AURA_OWNER_ID` to the owner's Supabase Auth user id.
3. Run `npm run migrate:supabase` once.
4. Set `AURA_STATE_BACKEND=supabase`.
5. Restart and verify chat history, memories, notifications, and tasks.

`render.yaml` and `Dockerfile` define a Render Starter web service. Configure
the secret environment variables in the Render blueprint, set
`AURA_PUBLIC_URL` to the deployed HTTPS origin, and add that exact origin to the
Supabase Auth redirect allowlist.

In the Supabase Dashboard, under Authentication -> Email Templates -> Magic
Link, point the link at `/auth/confirm` instead of the default
`{{ .ConfirmationURL }}`:

```
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=magiclink">Sign in to AURA</a>
```

The default template's link auto-verifies (and consumes) the one-time token
on its very first load, with no user action required — so a mail client's
in-app link preview, or any automated link scanner, silently burns the token
before the user gets to click it, and the sign-in fails with
`otp_expired`. `/auth/confirm` (`public/auth-confirm.html`) instead shows a
button and only calls `/auth/verify-link` when the user taps it, so the
token is spent by a deliberate action in the user's real browser.

All durable state stays in Supabase, so restarts and redeploys do not erase
conversations, tasks, notifications, Executive Loop cursors, memories, or
learned skills.

The Supabase cron route can remain as a durable backup to the in-process
scheduler. To configure that backup:

1. Generate a 64-character secret with `openssl rand -hex 32` and configure it
   in Render as `AURA_CRON_SECRET`. Do not paste it into chat or commit it.
2. In Supabase Vault, create `aura_deadline_origin` with the Render HTTPS origin
   and `aura_deadline_cron_secret` with that same random secret.
3. Run `supabase_free_scheduler.sql` in the Supabase SQL Editor.

Supabase then calls the protected deadline endpoint shortly after 7:00 AM
Phoenix time. Calls repeat briefly to survive a cold start, while AURA's durable
daily state prevents duplicate alerts.

In cloud mode, Apple Mail and Calendar requests become jobs in
`aura_companion_jobs`. Run `npm run companion` on the Mac to service them. The
companion only executes explicitly allowlisted capabilities.

Audited agent work is stored in `aura_actions`. Explicit owner commands can
authorize calendar, email, and Telegram execution immediately; destructive
deletions retain their separate approval gate.

## Architecture

- `server.js` — HTTP/WebSocket server, agent loop, tools, cron jobs
- `agent_router.js` — Core/Client Operations/Finance routing and least-privilege enforcement
- `executive_loop.js` — proactive inbox/calendar/meeting/commitment monitoring
- `entity_extraction.js` — canonical organization/domain/person extraction
- `entity_graph.js` — links a signal to profile people and CCC client records
- `goal_index.js` — durable goal entity index with cached embeddings
- `goal_signal_matcher.js` — two-tier deterministic + semantic goal matching
- `goal_match_store.js` — goal-connection ledger and adaptive thresholds
- `calendar_availability.js` — open business-hours windows from known events
- `reply_draft.js` — templated scheduling reply staged for owner approval
- `agent_policy.js` — tool authorization and argument validation
- `memory_store.js` — structured long-term memory
- `memory_v2.js` — pinned profile, extraction, corrections, retrieval, summaries
- `memory_extraction_queue.js` — durable asynchronous Luna extraction and retries
- `model_router.js` — Sol/Luna model configuration
- `supabase_state_store.js` — cloud conversations, memory, tasks, and approvals
- `companion_worker.js` — outbound Mac capability worker
- `ccc_database.js` — read-only CCC data/domain queries
- `mac_integration.js` — Apple Mail and Calendar reads
- `web_search.js` — sourced live public-web search
- `scraper.js` — Blackboard calendar and local browser access
- `public/` — tap-to-talk PWA
