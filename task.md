# task.md — Work Tracking for aura-ai

This file is the stateful "what's going on right now" tracker for engineers (human or AI) working
on this repo across sessions. It exists because work on AURA routinely gets interrupted — a session
ends, a context window fills up, a human goes to bed, a fix needs a Render redeploy that hasn't
happened yet — and the next person (or the next instance of Claude) picking this up cold needs to
know *what's in flight* without re-deriving it from git log and grep.

**This is not a substitute for `aura_actions`.** AURA already has a durable, queryable,
crash-surviving mechanism for pending approvals — the `aura_actions` table (see POLICY.md /
GROUNDING for the full propose → approve → execute pattern). If you want to know "is there an
owner-email or Telegram message awaiting approval right now," query `aura_actions` (or hit
`GET /api/actions/pending`) — don't look here, and don't duplicate that state here. `task.md` is
for the *broader* engineering work around AURA: the feature being built, the bug being chased, the
thing blocked on a human going and doing something outside the codebase. Same underlying idea as
`aura_actions` (make in-flight state legible and resumable instead of living only in one person's
head or one session's context) applied one level up, to the work of building AURA itself rather
than the actions AURA takes.

---

## How to use this file

Four sections, in this order: **Now**, **Blocked**, **Done recently**, **Next up**. Keep it
short — this is a whiteboard, not an audit log (git history is the audit log). When you pick up a
session:

1. Read **Now** and **Blocked** first — that's the state of the world.
2. If you finish or abandon something in **Now**, move it to **Done recently** (one line: what
   changed and why) or delete it if it turned out to be a non-issue.
3. If you get stuck on something external (a credential, a human decision, a permission grant,
   an env var only the deployment owner can set), move it to **Blocked** with a one-line note on
   *what exactly* is needed and *from whom*.
4. Prune **Done recently** periodically — keep roughly the last handful of items, not a permanent
   changelog. If it matters permanently, it belongs in a commit message or in GROUNDING/README, not
   here.
5. This is a template, not a rigid schema. Add a section (e.g. "Watching" for something to keep an
   eye on but not act on) if it genuinely helps. Don't add process for its own sake.

Each item should be legible to someone with zero session context: name the file(s), name the
concrete next action, and if something is blocked, name the blocker specifically enough that
whoever unblocks it knows what to do.

---

## Now

*What's actively being worked on this session/sprint.*

- **Stream the chat completion + TTS pipeline** to cut time-to-first-audio. Baseline today: even a
  zero-tool-call turn takes 3.5–5.6s end-to-end, and profiling points at LLM API round-trip time
  (GPT-5.6 Sol via `model_router.js`), not database queries, as the dominant cost. Goal is to start
  streaming tokens out of `/api/chat` and feeding Cartesia TTS (`/api/tts`, `sonic-3.5`, raw
  `fetch` to `https://api.cartesia.ai/tts/bytes`) incrementally instead of waiting for the full
  completion before synthesizing audio. Touches: `server.js` (`/api/chat`, `/api/tts` handlers),
  possibly `model_router.js`.
- **Reposition the on-screen search-results panel and add an on-screen conversation transcript** in
  the PWA frontend (`public/`). The search-results panel was recently re-enabled and re-skinned
  (see Done recently); this is the next visual/layout pass on top of that, plus adding a transcript
  view that doesn't currently exist.
- **Author the SOUL.md-companion documentation set** (this doc-authoring pass): `SKILL.md`,
  `TOOLS.md`, `CONTEXT.md`, `POLICY.md`, `AGENTS.md`, `task.md` (this file), `EVALS.md`. These are
  being written for the first time right now, alongside SOUL.md itself, to give future engineers
  (and AURA-adjacent tooling) a readable map of the system without having to reverse-engineer it
  from `server.js`.

## Blocked

*Waiting on something outside the codebase — a human decision, a credential, a permission grant.
Name exactly what's needed and from whom.*

- **Telegram bot token / chat ID not configured.** `telegram.js` and the `propose_telegram_message`
  / `confirm_telegram_message` tools in `server.js` are implemented and wired into the
  `aura_actions` approval queue, but `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are not set in the
  environment (`telegram.js:8` gates on both being present; `server.js:1225` returns "Telegram is
  not configured" and tells AURA to relay that to the owner). **Needs:** the owner (Chris) to
  create a Telegram bot via BotFather, get the bot token, get his own chat ID, and set both env vars
  (locally in `.env`, and on Render for cloud). Nothing further can be tested end-to-end on this
  channel until that happens.
- **Mac-companion permission grants.** `companion_worker.js` (running as the `com.aura.companion`
  launchd service) drives Apple Mail/Calendar via `mac_integration.js`'s AppleScript calls
  (`osascript`, `tell application "Mail"`). Some of these operations require macOS to have granted
  Automation/Accessibility permissions to the process running the worker (System Settings →
  Privacy & Security → Automation/Accessibility). If a companion job comes back with an AppleScript
  permission error, that's this — **needs:** a human at the physical Mac to click through the
  macOS permission dialog (or fix it in System Settings if the dialog was already dismissed once).
  This can't be granted remotely or from the cloud runtime.

## Done recently

*Last handful of shipped items. Prune older entries — this is not a permanent changelog; git log is.*

- Re-enabled and re-skinned the web-search results panel (frontend, `public/`).
- Gave AURA a readable memory/persona architecture (SOUL.md restructuring + `memory_v2.js` context
  building).
- Added an ambient aurora backdrop and light-casting halo behind the wordmark (frontend polish).
- Gave the background an actual Tron-style signature: grid floor, HUD frame, sonar sweep (frontend
  polish, same visual pass as above).
- Fixed a case-mismatched `SOUL.md` filename that was breaking the Render deploy (the loader read
  the file by exact name at boot; a case mismatch on a case-sensitive filesystem meant the module
  failed to load `AURA_SOUL` on Render even though it worked locally on Mac's case-insensitive
  filesystem).
- `MemoryV2.buildContext()` changed to fetch the pinned owner profile and semantically-related
  memories concurrently (`Promise.all`) instead of sequentially — a real latency fix, not
  speculative.

## Next up

*Not started, but known and roughly prioritized. Not a backlog dump — only things someone has
actually decided are coming next.*

- Once the streaming pipeline lands, re-measure time-to-first-audio against the 3.5–5.6s baseline
  above and record the new number somewhere durable (README or a follow-up commit message), so the
  next latency investigation has a real before/after instead of a vague memory of "it used to be
  slow."
- After the Telegram token is configured (see Blocked), do a live end-to-end test of
  `propose_telegram_message` → owner approval word → `confirm_telegram_message` →
  `executeApprovedAction()` dispatch, the same way the test-letter-deletion path has presumably
  already been exercised. This is the one owner-facing action-queue path that has never actually
  fired in production.
- Decide whether the on-screen conversation transcript (once built) should read from
  `aura_messages` directly or ride along on the existing WebSocket push used for the scheduled
  proactive checks (8am/4pm client-account checks, 7am Blackboard deadlines, Monday 9am stale
  goals) — needs a quick look at how that socket channel is structured in `server.js` before
  committing to an approach.

---

## Why this exists alongside `aura_actions`

It's worth being explicit about the boundary, since both are "track in-flight state so it survives
an interruption":

| | `aura_actions` (database table) | `task.md` (this file) |
|---|---|---|
| Tracks | A single proposed tool call (send this email, delete this letter) awaiting owner approval | Ongoing engineering work: features, bugs, docs, refactors |
| Survives | Process restarts, redeploys — it's a Postgres row, checked via timestamp comparison (`redeemStagedDeletion`/`redeemPendingAction` in `server.js`), not an in-memory counter | Git commits and session boundaries — it's a checked-in file, read at the start of a session |
| Granularity | One row per action, with `status` (`proposed`/`approved`/`rejected`/`executing`/`succeeded`/`failed`/`expired`/`cancelled`) and a hard 10-minute TTL (`DELETION_CONFIRMATION_TTL_MS`) | One bullet per unit of work, no formal state machine, pruned by hand |
| Queried by | AURA itself, at inference time (`list_pending_owner_actions` tool, `GET /api/actions/pending`) | A human or an AI engineer opening the repo, at the start of a session |
| Authority for "did the owner approve this" | The literal text the owner typed/said, matched against `OWNER_APPROVAL_PATTERN`/`OWNER_REFUSAL_PATTERN` — never what the model claims | N/A — no approval semantics here at all |

If you find yourself wanting to log "email to owner proposed, awaiting approval" in `task.md`,
that's a sign you should be looking at `aura_actions` instead — this file has no TTL, no approval
gate, and no audit trail, and pending actions already have a better home.
