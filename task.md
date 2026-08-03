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

- **Deploy and live-test calendar grounding plus smoother voice.** `calendar_time.js` now supplies
  an authoritative Phoenix clock and corrects relative dates before staging. The voice pipeline now
  waits for one complete opening sentence, groups the remainder for connected Cartesia prosody, and
  avoids sentence-by-sentence WAV seams across PWA, Telegram, and proactive voice. After deploy,
  repeat the calendar test and compare conversational cadence/TTFA on a two-or-three-sentence reply.

## Blocked

*Waiting on something outside the codebase — a human decision, a credential, a permission grant.
Name exactly what's needed and from whom.*

- **Mac-companion permission grants.** `companion_worker.js` (running as the `com.aura.companion`
  launchd service) drives Apple Mail/Calendar via `mac_integration.js`'s AppleScript calls.
  Some operations need macOS Automation/Accessibility grants to the worker process. Can't be
  granted remotely. (Less urgent while Google Calendar write is the primary schedule path.)

## Done recently

*Last handful of shipped items. Prune older entries — this is not a permanent changelog; git log is.*

- Google Calendar write OAuth configured on Render and verified against the Calendar API. The API
  returned real event ids/links; the remaining failure was incorrect relative-date grounding.
- Voice smoothness pass: removed comma/dash/six-word early fragments, kept a fast complete first
  sentence, grouped later sentences into continuous Cartesia performances, and refined `SOUL.md`
  so compact replies stay connected rather than telegraphic.
- Morning brief reformatted (#23): "Good morning, Chris", multi-line Telegram, optional voice note.
- Voice latency chase (#18–22): TTFA harness, `gpt-4o-mini-transcribe`, early-clause TTS + 24kHz,
  Grok `reasoning_effort=low`, chit-chat fast path. Measured TTFA ~7940ms → ~4696ms.
- Goal due dates, morning brief cron, Google iCal read, week-ahead calendar (#15–17).
- PWA conversation transcript panel + mobile search panel lifted above orb controls; `/api/messages`
  endpoint; `scripts/google-calendar-oauth.js` + `npm run google:calendar-oauth`.
- `propose_email` live-model eval case landed in `eval/cases.json` (`forbiddenTools`).

## Next up

*Not started, but known and roughly prioritized. Not a backlog dump — only things someone has
actually decided are coming next.*

- Add enforced GitHub CI checks; current PRs have no status checks and rely on locally reported
  `npm test` / `npm run check` results.
- `aura_agents` persona routing — only if scoped personas are wanted; schema exists, no router
  (see `AGENTS.md`).

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
