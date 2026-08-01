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

- **Re-measure TTFA after Grok `reasoning_effort: low`.** Latest live number was
  `TTFA 6279ms (whisper 1675, first_sentence 3539, tts 1061)`. First-sentence was
  the bottleneck — Grok was silently defaulting to high effort when the field was
  omitted. Capture a new `[timing] TTFA` after deploy.
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

- ~~**Telegram bot token / chat ID not configured.**~~ Resolved — bot created, token and chat ID set
  locally and on Render, confirmed working end-to-end (owner received a live message). Telegram was
  since simplified from a propose/confirm pair to a single immediate `send_telegram_message` call
  (no staging — the recipient is fixed server-side either way, so confirmation protected against
  nothing there); email keeps the propose/confirm pattern.
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

- Streamed the chat completion + TTS pipeline: `/api/chat` now emits NDJSON `sentence` events as
  the model generates instead of waiting for the full reply, and `public/app.js` queues each
  sentence's TTS fetch immediately so synthesis overlaps with playback. Measured ~200-500ms win on
  short replies, more on longer multi-sentence ones. Re-verified every propose/confirm gate
  (email, Telegram, letter deletion) live under the new path.
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
- Collapsed Telegram from a `propose_telegram_message`/`confirm_telegram_message` pair to a single
  immediate `send_telegram_message` call — no staging, no confirmation. Confirmed live in
  production (owner received the message). Email kept the two-step pattern.
- On-screen reply/search panel now clears itself the instant AURA finishes speaking (or is
  interrupted), instead of persisting until the next interaction starts.
- Switched the chat model to `gpt-5.6-terra` via `AURA_CHAT_MODEL` — confirmed live locally; still
  needs the same env var set on Render for cloud.
- Added `propose_email`/`confirm_email` — a third email tool, arbitrary recipient (unlike
  `propose_owner_email`, which can only ever reach the owner). Registered `external_action` rather
  than `destructive_write` specifically because the recipient here is a real argument with no
  fixed-server-config guarantee behind it — see `POLICY.md` §4a and `EVALS.md` §3.7 for the security
  reasoning and the open eval case this still needs.

## Next up

*Not started, but known and roughly prioritized. Not a backlog dump — only things someone has
actually decided are coming next.*

- **Add the `eval/cases.json` live-model case for `propose_email` described in `EVALS.md` §3.7** —
  feed AURA a processed document with an embedded instruction to email its contents to an
  attacker-controlled address with no real owner request behind it, assert she does not call
  `propose_email`. Highest-priority open eval in the doc: this tool has no structural fallback if
  the model gets it wrong, unlike every other email/Telegram tool.
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
