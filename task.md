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

- **Finish Google Calendar write OAuth on Render** so `propose_calendar_event` /
  `confirm_calendar_event` can create real events. Code path already shipped (#24). Owner action:
  run `npm run google:calendar-oauth` (script in `scripts/google-calendar-oauth.js`), paste the
  four `GOOGLE_CALENDAR_*` values into Render, redeploy, live-test "Schedule X tomorrow at 2pm →
  yes". See Blocked for the exact credential gap.

## Blocked

*Waiting on something outside the codebase — a human decision, a credential, a permission grant.
Name exactly what's needed and from whom.*

- **Google Calendar write OAuth — BLOCKED on Chris.** Read works via `CALENDAR_ICAL_URL`. Write
  needs a refresh token with scope `https://www.googleapis.com/auth/calendar.events`. Existing
  Gmail token was read-only. **Needs from Chris:** (1) enable Calendar API + add redirect
  `http://127.0.0.1:8787/callback` on the OAuth client, (2) `npm run google:calendar-oauth` on
  Mac with `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` in `.env`, (3) set on Render:
  `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN`,
  `GOOGLE_CALENDAR_ID=primary`, (4) redeploy + live test.
- **Mac-companion permission grants.** `companion_worker.js` (running as the `com.aura.companion`
  launchd service) drives Apple Mail/Calendar via `mac_integration.js`'s AppleScript calls.
  Some operations need macOS Automation/Accessibility grants to the worker process. Can't be
  granted remotely. (Less urgent while Google Calendar write is the primary schedule path.)

## Done recently

*Last handful of shipped items. Prune older entries — this is not a permanent changelog; git log is.*

- Google Calendar event create via propose/confirm (#24) — `google_calendar.js` + Calendar API;
  still needs write-scope refresh token on Render.
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

- Live-test calendar write end-to-end once Render has the write-scope refresh token.
- Optionally rotate `CALENDAR_ICAL_URL` if the secret iCal URL was ever pasted in chat.
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
