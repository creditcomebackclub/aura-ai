# CONTEXT.md — Runtime & Deployment Environment

This document exists so that anyone (human or AI) touching this repo knows **which
machine and which mode** their change actually affects before they make it. AURA
runs in two places at once, against one shared database. Get this wrong and you'll
debug against the wrong process, restart the wrong service, or "fix" a data
inconsistency that is actually working as designed.

If you only read one section, read "The shared-Supabase tradeoff" below.

---

## 1. The two runtime modes

AURA has exactly one codebase (`server.js` plus its modules) that runs in two
places:

| | Local Mac | Render Cloud |
|---|---|---|
| `AURA_RUNTIME` | unset, or `mac` | `cloud` |
| Where it runs | `chriss-macbook-pro`, as a launchd service | Render web service `aura-brain` (Docker) |
| State backend | SQLite (`aura.db`) by default per `.env.example`, but **this machine's actual `.env` sets `AURA_STATE_BACKEND=supabase`** — see below | Always `AURA_STATE_BACKEND=supabase` (set in `render.yaml`) |
| Bind host | `127.0.0.1` (LAN-only by default) | `0.0.0.0` (set in `render.yaml` as `AURA_BIND_HOST`) |
| Apple Mail / Calendar | Direct AppleScript via `mac_integration.js` | Routed through `companion_client.js` → `aura_companion_jobs` queue → `companion_worker.js` on the Mac |
| Puppeteer / Blackboard scraping | Available (`scraper.js`) | Skipped — `Dockerfile` sets `PUPPETEER_SKIP_DOWNLOAD=true`, and `scraper.js` checks `AURA_RUNTIME === 'cloud'` to short-circuit |

You can always confirm which mode a running instance is in by hitting its health
endpoint:

```bash
curl http://<host>/healthz
# { "ok": true, "runtime": "mac" | "cloud", "brain": {...}, "timestamp": ... }
```

`server.js` reports `runtime: process.env.AURA_RUNTIME || 'mac'` there — `mac` is
the fallback if the variable is simply absent, not a guarantee the box is actually
the Mac.

### How mode selection actually works in code

Three environment variables drive behavior, and they are **independent knobs**,
not one setting:

- **`AURA_RUNTIME`** (`'mac'` or `'cloud'`) — read directly at several call sites
  in `server.js` (e.g. deciding whether Apple Mail/Calendar tools call
  `mac_integration.js` directly or go through `companionClient`; deciding the
  default bind host; gating localhost-only auth bypasses) and in `scraper.js`
  (skip Blackboard scraping entirely in cloud mode). It answers "where am I
  running and what hardware do I have direct access to."
- **`AURA_STATE_BACKEND`** (`'sqlite'` or `'supabase'`) — read once at boot into
  the `useSupabaseState` boolean (`server.js:51`). It answers "where does durable
  state live," independently of `AURA_RUNTIME`. This is what actually lets local
  dev point at the same Supabase project as production.
- **`useSupabaseState`** — the derived boolean
  (`process.env.AURA_STATE_BACKEND === 'supabase'`). When false, `server.js`
  opens a local `better-sqlite3` file (`db = new Database('aura.db')`, with its
  own `memory` / `goals` / `finances` / `notifications` tables created inline at
  boot). When true, `db` stays `null` and all durable reads/writes route through
  `supabase_state_store.js` / `cloudState` instead. Everything gated on this
  boolean — conversation history, memories, tasks, notifications, pending
  actions — moves together; there is no partial state migration.

In short: `AURA_RUNTIME` picks which physical capabilities are available
(Mac hardware vs. cloud sandbox); `AURA_STATE_BACKEND` picks which database the
process talks to. Render's `render.yaml` sets both (`AURA_RUNTIME=cloud`,
`AURA_STATE_BACKEND=supabase`). The Mac's `.env.example` template ships with
`AURA_RUNTIME=mac` + `AURA_STATE_BACKEND=sqlite` (a fresh, fully local install),
but **the actual deployed Mac instance has been migrated** — its real `.env` sets
`AURA_STATE_BACKEND=supabase` too (see `README.md`, "Cloud brain migration").
Don't assume the Mac is on SQLite just because that's the template default —
check the actual `.env` (or `/healthz`, which won't tell you the backend, so
check `.env` directly, or ask `npm run memory:view`, which only works against
Supabase).

---

## 2. The shared-Supabase tradeoff

Because both the Mac's `.env` and Render's `render.yaml` set
`AURA_STATE_BACKEND=supabase` against the **same Supabase project**, local dev
and cloud production are not two environments — they are **one runtime, two
processes, sharing one live conversation**. There is exactly one owner
(`AURA_OWNER_ID`, owner_id `77fd9939-c522-47a2-b81f-9866399ad58c`) and exactly
one `aura_conversations` row that both the Mac process and the Render process
read from and append to.

**This is a known, accepted tradeoff — not a bug to fix.** Concretely it means:

- Talking to AURA locally while testing a change and talking to AURA in
  production (e.g. from your phone hitting the Render URL) append to the *same*
  message history and can trigger the *same* rolling-summary regeneration
  (`ConversationSummaryService`, `AURA_SUMMARY_MESSAGE_THRESHOLD`).
- Dev-testing noise mixes into the real memory/summary pipeline. This has
  already caused one real incident: a summary told AURA she lacked database
  access she actually had, traced to bulk-imported pre-fix conversation history
  mixed with noisy dev-testing traffic in that one shared conversation.
  `findSelfCapabilityNegation()` in `memory_v2.js` exists specifically to catch
  that class of poisoning going forward; `GET /api/memory/view` and
  `npm run memory:view` exist to let a human eyeball the live memory/profile
  document without waiting to notice bad behavior first.
- Do not propose "just isolate local from prod" as a fix unless the user asks
  for it — this has been evaluated and rejected before. If a change you're
  making would add meaningfully more dev-testing traffic to the shared
  conversation, mention it rather than silently accepting the pollution.

---

## 3. The two launchd services (Mac only)

The Mac instance runs as **two independent per-user LaunchAgents**, not one.
They start at login, restart automatically on crash, and log to plain files in
the repo root (all four log files are gitignored via the blanket `*.log` rule).

| Service | Label | Plist | Runs | Log (stdout) | Log (stderr) |
|---|---|---|---|---|---|
| Main server | `com.aura.ai` | `~/Library/LaunchAgents/com.aura.ai.plist` | `node /Users/chris/aura-ai/server.js` | `aura-service.log` | `aura-service-error.log` |
| Mac companion worker | `com.aura.companion` | `~/Library/LaunchAgents/com.aura.companion.plist` | `node /Users/chris/aura-ai/companion_worker.js` | `aura-companion.log` | `aura-companion-error.log` |

Both run with `WorkingDirectory=/Users/chris/aura-ai`, `NODE_ENV=production`,
`KeepAlive=true`, and a `ThrottleInterval` (10s for `com.aura.ai`, 15s for
`com.aura.companion`) so a crash-loop doesn't spin the CPU. `com.aura.companion`
additionally sets `LimitLoadToSessionType=Aqua` (it needs the logged-in GUI
session for AppleScript/Apple Mail access) and `AURA_COMPANION_POLL_MS=10000`
in its own environment block.

**Inspecting a service:**

```bash
launchctl print gui/$(id -u)/com.aura.ai
launchctl print gui/$(id -u)/com.aura.companion
```

**Restarting a service** (kills and immediately relaunches — this is the normal
way to pick up a code change on the Mac, since neither service watches files):

```bash
launchctl kickstart -k gui/$(id -u)/com.aura.ai
launchctl kickstart -k gui/$(id -u)/com.aura.companion
```

**Tailing logs:**

```bash
tail -f /Users/chris/aura-ai/aura-service.log
tail -f /Users/chris/aura-ai/aura-service-error.log
tail -f /Users/chris/aura-ai/aura-companion.log
tail -f /Users/chris/aura-ai/aura-companion-error.log
```

If you edit `server.js` and the Mac's behavior doesn't seem to change, the
usual cause is forgetting to `kickstart -k com.aura.ai` — there is no
hot-reload.

`companion_worker.js` polls `aura_companion_jobs` for
`target_device = AURA_COMPANION_DEVICE` (`chriss-macbook-pro`), claims one job
at a time, executes it via `mac_integration.js`, and writes status/result back.
It is the only thing that makes Apple Mail/Calendar reachable from the cloud
process — if `com.aura.companion` is down, cloud-side `check_email`,
`check_calendar`, and `send_email` jobs will queue in `aura_companion_jobs` and
simply never complete.

---

## 4. Deploy mechanism (cloud)

- **Deploy trigger:** pushing a commit to the **`codex/aura-cloud-brain`**
  branch. `render.yaml` sets `autoDeployTrigger: commit`, so Render watches that
  branch specifically and redeploys on every push to it.
- **`main` is a synced backup ref only** — it is not what Render builds from.
  Do not expect a push to `main` to deploy anything, and do not assume
  `codex/aura-cloud-brain` and `main` are interchangeable when reasoning about
  "what's live."
- **Build:** Render builds the Docker image from the repo's `Dockerfile`
  (`runtime: docker` in `render.yaml`), on the `free` plan, health-checked at
  `/healthz`.
- **What the container serves:** the same Express process serves both the
  static PWA frontend (`public/`) and the API — there is no separate frontend
  deploy or CDN step.
- **Cloud-specific Dockerfile behavior:** `ENV AURA_RUNTIME=cloud` is baked into
  the image itself (not just `render.yaml`), `PUPPETEER_SKIP_DOWNLOAD=true` is
  set so the Puppeteer postinstall doesn't try to fetch a browser binary, and
  `npm ci --omit=dev --ignore-scripts` skips native builds Linux doesn't need
  (e.g. `better-sqlite3`'s prebuilt binary is not compiled from source; it's
  unused anyway once `AURA_STATE_BACKEND=supabase` is set).
- **Free-tier sleep:** Render's free plan sleeps the service after 15 minutes
  with no inbound HTTP/WebSocket traffic; the next request wakes it (roughly a
  minute of cold-start latency). All durable state lives in Supabase, so
  sleep/redeploy cycles don't lose conversations, memories, tasks, or
  notifications. The in-process 7am deadline-check cron cannot fire while the
  service is asleep — see `supabase_free_scheduler.sql` / `AURA_CRON_SECRET`
  for the Supabase-side pinger that works around this (documented in
  `README.md`, "Cloud brain migration").

Practical implication: if you need a change live on the phone/production
surface, it must be committed and pushed to `codex/aura-cloud-brain`
specifically. There is no separate manual "deploy" step to run.

---

## 5. Where secrets live

- **Locally:** `.env` at the repo root, gitignored (`.gitignore` lists `.env`
  and `.env.local`). `.env.example` is the checked-in template documenting every
  variable the app reads (API keys, `AURA_OWNER_ID`, `AURA_STATE_BACKEND`,
  `AURA_RUNTIME`, `AURA_ACCESS_TOKEN`, email OAuth vars, `BLACKBOARD_ICAL_URL`,
  `CALENDAR_ICAL_URL`,
  etc.) with placeholder values only.
- **Cloud:** Render dashboard environment variables, configured against the
  `render.yaml` blueprint. Secret-shaped entries in `render.yaml` are declared
  with `sync: false` (e.g. `OPENAI_API_KEY`, `CARTESIA_API_KEY`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_KEY`, `AURA_OWNER_ID`, `AURA_CRON_SECRET`,
  `BLACKBOARD_ICAL_URL`) — meaning Render tracks that the key exists but the
  value itself is set by hand in the Render dashboard, never committed or
  synced from the blueprint file. Non-secret operational config (model names,
  timeouts, feature flags, timezone) is set inline in `render.yaml` with plain
  `value:` entries.
- **Never commit either file's actual values.** If you add a new secret-bearing
  environment variable, add its name (with a placeholder) to `.env.example` and
  its name (with `sync: false`) to `render.yaml`, and set the real value only in
  the local `.env` / the Render dashboard.

---

## 6. Quick reference — "what am I actually touching?"

- Editing `server.js` and testing against `npm start` / the launchd service on
  this Mac → you are on **local Mac mode**, and if `.env` has
  `AURA_STATE_BACKEND=supabase` (it does, on this machine), you are **also**
  reading/writing the **one shared production conversation**. Assume your test
  messages are visible in the real conversation history and rolling summary.
- Pushing to `codex/aura-cloud-brain` → **this deploys to Render**
  automatically. There is no staging environment between your push and
  production.
- Pushing to `main` → does not deploy anywhere; it's a backup ref.
- Need something only the Mac can do (Apple Mail, Apple Calendar,
  Blackboard scraping via Puppeteer) while running in cloud mode → it has to go
  through the `aura_companion_jobs` queue to `com.aura.companion` on this Mac.
  If that queue isn't draining, check whether `com.aura.companion` is loaded
  and check `aura-companion-error.log`.
- Something in the live conversation looks wrong (poisoned summary, missing
  memory, weird pinned fact) → check `GET /api/memory/view` or
  `npm run memory:view` before assuming it's a code bug; it may be shared-state
  pollution from dev traffic (see Section 2), which is expected, not a defect.
