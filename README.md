# AURA

AURA is a local, voice-first personal assistant with long-term memory, proactive
notifications, Apple Mail and Calendar access, Blackboard monitoring, and
read-only business intelligence for Credit Comeback Club.

## Setup

1. Install Node.js 20 or newer and run `npm install`.
2. Copy `.env.example` to `.env` and fill in the required credentials.
3. Run `supabase_setup.sql` once in the Supabase SQL editor.
4. Start AURA with `npm start`.
5. Open `http://localhost:3000`.

OpenAI is currently required for transcription and semantic embeddings even when
`AI_PROVIDER=deepseek` is used for chat. AURA's public internet tool uses
OpenAI Responses web search with live access and source metadata. Cartesia
provides speech synthesis.

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
- Memory can be inspected with `GET /api/memories` and deleted with
  `DELETE /api/memories/:id`.

The existing `semantic_memory.json` file is imported non-destructively into the
structured SQLite memory table at startup.

## Memory v2

AURA keeps an always-loaded owner profile for stable identity facts, people and
relationships, communication preferences, pronunciations, and business rules.
Other durable facts remain searchable through hybrid exact and vector retrieval.
Conversation continuity is maintained with rolling summaries in Supabase.

AURA extracts durable facts automatically with the configured background model.
These commands are also handled explicitly:

```text
Remember that I prefer meetings at 10 AM.
Forget about my preferred meeting time.
Correction: I prefer meetings at 11 AM.
Pronounce "WK 4" as "week four."
```

Credentials, tokens, passwords, and one-time codes are never eligible for
memory. Inspect the structured profile at `GET /api/profile`, remove one entry
with `DELETE /api/profile/:key`, and inspect semantic memories at
`GET /api/memories`.

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

Normal conversation and tool decisions use `AURA_CHAT_MODEL` (currently
`gpt-5.6-sol`) with `AURA_REASONING_EFFORT=medium`. Automatic durable-fact
extraction and rolling summaries use the lower-cost `AURA_MEMORY_MODEL`
(`gpt-5.6-luna`). Both choices are environment-configurable.

## Voice interface

The phone and home-screen interface is text-free. A canvas waveform reacts to
AURA's actual speech through the Web Audio API, with a reduced-motion fallback.
Sourced live-web results remain readable and clickable on desktop screens with
a fine pointer, while staying hidden on the mobile voice surface.

## Notifications

Proactive alerts are persisted before being emitted over WebSockets, so alerts
are not lost merely because the UI is disconnected. Unacknowledged alerts are
available at `GET /api/notifications`; acknowledge one with
`POST /api/notifications/:id/acknowledge`.

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

`render.yaml` and `Dockerfile` define a $0 Render Free web service. Configure
the secret environment variables in the Render blueprint, set
`AURA_PUBLIC_URL` to the deployed HTTPS origin, and add that exact origin to the
Supabase Auth redirect allowlist.

Render Free sleeps after 15 minutes without inbound HTTP or WebSocket traffic.
Opening AURA wakes it, which can take about a minute. All durable state stays in
Supabase, so sleeping and redeploying do not erase conversations, tasks,
notifications, or memories.

The in-process 7:00 AM deadline timer cannot run while Render is asleep. To keep
that check reliable without a paid cron service:

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

Proposed agent work is stored in `aura_actions`. Read actions can be automatic;
reversible writes and external actions remain pending until the authenticated
owner approves or rejects them.

## Architecture

- `server.js` — HTTP/WebSocket server, agent loop, tools, cron jobs
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
