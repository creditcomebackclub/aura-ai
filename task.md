# task.md — Work Tracking for aura-ai

This file is the stateful "what's going on right now" tracker for engineers (human or AI) working
on this repo across sessions. It exists because work on AURA routinely gets interrupted — a session
ends, a context window fills up, a human goes to bed, a fix needs a Render redeploy that hasn't
happened yet — and the next person (or the next instance of Claude) picking this up cold needs to
know *what's in flight* without re-deriving it from git log and grep.

**This is not a substitute for `aura_actions`.** AURA already has a durable, queryable,
crash-surviving action audit and approval mechanism in the `aura_actions` table (see POLICY.md).
If you want to inspect a send result or a deletion awaiting approval, query `aura_actions` (or hit
`GET /api/actions/pending` for staged items) — don't look here, and don't duplicate that state here. `task.md` is
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

- **Ship Meeting Intelligence MVP.** Enrich the existing 8–20 minute brief with verified CCC
  attendee context and matching open follow-ups, then test, deploy, and verify without changing
  the calendar or sending email.

## Blocked

*Waiting on something outside the codebase — a human decision, a credential, a permission grant.
Name exactly what's needed and from whom.*

- **Mac-companion permission grants.** `companion_worker.js` (running as the `com.aura.companion`
  launchd service) drives Apple Mail/Calendar via `mac_integration.js`'s AppleScript calls.
  Some operations need macOS Automation/Accessibility grants to the worker process. Can't be
  granted remotely. (Less urgent while Google Calendar write is the primary schedule path.)

## Done recently

*Last handful of shipped items. Prune older entries — this is not a permanent changelog; git log is.*

- Gmail monitoring switched from `aura.ai.brain@gmail.com` to
  `creditcomebackclub@gmail.com`; production and local OAuth identity were verified and the CCC
  inbox was baselined without replaying old unread messages. Calendar OAuth remained untouched.
- Mailbox-aware follow-through shipped in #30–31: AURA monitors recent sent mail, turns explicit
  owner promises with concrete deadlines into deduplicated internal tasks, ignores quoted mail,
  and throttles Gmail metadata reads across the Mac/cloud schedulers.
- Executive Loop v1 deployed and baselined: actionable email, calendar changes, meeting briefs,
  and due commitments now run every five minutes with durable deduplication and quiet hours.
- Calendar grounding and smoother connected voice shipped in #25; the mistaken April 8 and April 15
  test events were deleted and verified as cancelled through the Calendar API.
- Google Calendar write OAuth configured on Render and verified against the Calendar API. The API
  returned real event ids/links; relative dates are now grounded by the server clock.
- Voice smoothness pass: removed comma/dash/six-word early fragments, kept a fast complete first
  sentence, grouped later sentences into continuous Cartesia performances, and refined `SOUL.md`
  so compact replies stay connected rather than telegraphic.
- Morning brief reformatted (#23): "Good morning, Chris", multi-line Telegram, optional voice note.
- Voice latency chase (#18–22): TTFA harness, `gpt-4o-mini-transcribe`, early-clause TTS + 24kHz,
  Grok `reasoning_effort=low`, chit-chat fast path. Measured TTFA ~7940ms → ~4696ms.
- Goal due dates, morning brief cron, Google iCal read, week-ahead calendar (#15–17).
- PWA conversation transcript panel + mobile search panel lifted above orb controls; `/api/messages`
  endpoint; `scripts/google-calendar-oauth.js` + `npm run google:calendar-oauth`.
- Third-party `send_email` prompt-injection eval case lives in `eval/cases.json` (`forbiddenTools`).
- Direct calendar and email commands execute immediately (#26–27); hardcoded spoken tool-working
  filler was removed so voice waits for the real result (#28).

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
| Tracks | Audited tool calls and proposed destructive actions; email/calendar/Telegram execute directly while deletions may await approval | Ongoing engineering work: features, bugs, docs, refactors |
| Survives | Process restarts and redeploys — it is a Postgres row; staged deletion approval uses a timestamp comparison in `redeemStagedDeletion`, while direct sends record their outcome durably | Git commits and session boundaries — it's a checked-in file, read at the start of a session |
| Granularity | One row per action, with `status` (`proposed`/`approved`/`rejected`/`executing`/`succeeded`/`failed`/`expired`/`cancelled`) and a hard 10-minute TTL (`DELETION_CONFIRMATION_TTL_MS`) | One bullet per unit of work, no formal state machine, pruned by hand |
| Queried by | The action executor and the PWA (`GET /api/actions/pending`) | A human or an AI engineer opening the repo, at the start of a session |
| Authority for "did the owner approve this" | The literal text the owner typed/said, matched against `OWNER_APPROVAL_PATTERN`/`OWNER_REFUSAL_PATTERN` — never what the model claims | N/A — no approval semantics here at all |

If you find yourself wanting to log an individual send or proposed deletion in `task.md`,
look at `aura_actions` instead — this file has no execution status, TTL, or audit trail.
