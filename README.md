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
`AI_PROVIDER=deepseek` is used for chat. Cartesia provides speech synthesis.

## Phone and LAN access

Localhost works without a token. All non-localhost API and WebSocket connections
are denied unless `AURA_ACCESS_TOKEN` is set.

To pair a phone on the same network, use:

```text
http://YOUR_MAC_IP:3000/?token=YOUR_AURA_ACCESS_TOKEN
```

The browser stores the token locally and removes it from the visible URL. Use a
long random token and do not share that URL.

## Privacy and security

- Supabase is accessed only by the server. Never expose its service-role key to
  browser code.
- Tool arguments are validated and tools are classified as read-only,
  reversible writes, or blocked.
- Tool results, emails, webpages, database values, and memories are explicitly
  treated as untrusted data rather than agent instructions.
- Conversation history, structured memories, notifications, goals, and finance
  logs are stored locally in `aura.db`.
- Raw Blackboard text is not saved unless `AURA_DEBUG_SCRAPES=true`.
- Memory can be inspected with `GET /api/memories` and deleted with
  `DELETE /api/memories/:id`.

The existing `semantic_memory.json` file is imported non-destructively into the
structured SQLite memory table at startup.

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

When no calendar URL is configured, AURA uses a persistent browser session.
Renew an expired session with:

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

The unit suite covers tool authorization and validation, structured memory
deduplication and retrieval, deletion, and graceful embedding outages. The live
evaluation suite checks real model tool selection, business lookup behavior, and
a prompt-injection regression case. Add scenarios to `eval/cases.json`.

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

`render.yaml` and `Dockerfile` define the always-on cloud service. Configure the
secret environment variables in the Render blueprint, set `AURA_PUBLIC_URL` to
the deployed HTTPS origin, and add that origin to the Supabase Auth redirect
allowlist.

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
- `supabase_state_store.js` — cloud conversations, memory, tasks, and approvals
- `companion_worker.js` — outbound Mac capability worker
- `ccc_database.js` — read-only CCC data/domain queries
- `mac_integration.js` — Apple Mail and Calendar reads
- `scraper.js` — Blackboard and web search
- `public/` — tap-to-talk PWA
