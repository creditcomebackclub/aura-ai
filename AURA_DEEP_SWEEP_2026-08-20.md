# AURA Deep Sweep — 2026-08-20

Scope: the `main` first-parent history from 2026-08-01 through 2026-08-17,
plus a static trace of the current browser voice path, memory pipeline, model
loop, state store, recent test coverage, and the available local service-error
log. This is not a complete production-log analysis; the telemetry
recommendations below still need live data.

## Executive assessment

AURA has gained a lot of capability in a short period: durable memory,
asynchronous learning, adaptive model routing, specialist lenses, proactive
workflows, action receipts, streaming STT/TTS, and voice barge-in. The main
risk is interaction complexity, not a single failing subsystem. Several
low-latency optimizations now interact across client playback, server streaming,
tool recovery, and live microphone capture.

The first stabilization objective is simple: one owner turn produces one
authoritative answer, one active audio output, and one auditable durable-memory
outcome. The hardening work described below is now implemented in this working
tree; production burn-in and live telemetry review remain release gates.

## Implementation status

| Finding / candidate | Implemented result |
| --- | --- |
| Duplicate speech | Tool-capable rounds buffer speech until the final corrected answer. Every chat event carries `turn_id`, `generation`, and monotonic `sequence`; the client fences stale events. |
| Proactive alert collision | Browser alerts defer while processing, listening, or speaking, then drain one at idle through a bounded, deduplicated queue. |
| Durable preferences | Profile mutations now use bounded compare-and-set retries. Passive preference confirmations carry a durable candidate id, accept explicit phrases such as “do it,” and are appended deterministically. |
| Memory operations | `/control.html` exposes pending candidates, stored profile facts, and queue outcomes; guarded endpoints resolve candidates or replay failed jobs. |
| Voice proof | `public/voice_turn_protocol.js` has behavior tests for stale turns, generations, sequences, mixed-version events, and alert deferral. Privacy-bounded `/api/audio/turn-events` captures lifecycle metadata without audio or transcript text. |
| Evidence cards | The existing receipt panel now shows successful and failed tool evidence even when no web result is present. |
| Client watchlist | `GET /api/clients/watchlist` returns deterministic overdue-balance, billing-status, and stalled-phase signals with configurable thresholds. |
| Email commitment inbox | Sent-mail promises enter `awaiting_approval`; authenticated review endpoints approve or reject them before they become active tasks. |
| Reliability digest | `GET /api/reliability/status` combines memory, tools, pending preferences, commitment candidates, CCC watchlist signals, and integration errors. An issue-only digest runs once daily. |
| Volume stutter | The in-app volume control, gain node, and compressor are removed; playback uses native device volume and the minimal analyser-to-output graph. |
| First-turn tool denials | Explicit live-data questions now require a relevant read tool on round zero. Passive denial wording is caught, successful receipts remain usable for correction, and real quota/database failures get precise wording. |

## Recent change inventory

| Area | Changes on `main` |
| --- | --- |
| Voice and latency | `635cf93` skips costly context for chit-chat; `771126f`, `4aec6f8`, `43c632c`, `70ff9fd`, `cc3664e` move to Deepgram Nova-3 live capture and tune endpointing; `0b31405` adds Luna routing, parallel tools, and streamed TTS; `b2cd671` permits longer utterances; `9783413` adds voice barge-in; `24576d9` replaces the initial interruption detector with adaptive VAD and adds diagnostics. |
| Model correctness and observability | `29121d0` adds adaptive reasoning; `58d120e` restores low-latency routing; `85c3b94` hardens chat cancellation, durable extraction queue handling, and telemetry; `934f1a0` adds phase timing; `154f0a9` attempts recovery from false tool denials; `8d7b568` holds routine briefings at low effort; `18630b2`/`c032026` return the primary chat model to GPT-5.6 Sol at medium effort. |
| Memory and learning | `b6ba8b0` expands relationship memory; `c35de26`, `cc2f6d4`, `49234a3`, `560e342`, `10d6cfa`, `6defb26` add reflection, health reporting, outcomes, episodic memory, belief consolidation, and retrieval tracing; `23d570c` and `10bfbd0` persist learned skills; `de898fc` adds confirmation for uncertain preferences; `45a79b8` makes proactive briefings honor stored preferences; `0e22ed7` applies a learned spark preference. |
| Goals, reminders, and external actions | `3a257f7`, `966c917`, `d60c2cb`, `e9387ab` add signal-to-goal links, contact/client grounding, staged scheduling intent, and durable goal plans; `0507919` adds durable reminders and execution receipts. |
| Integrations | `df40ed2`, `35b8411`, `d77d521`, `237e35a`, `477182f`, `fb8dfaa` build out calendar grounding, create/reschedule/cancel, natural commands, and date selection; `0881d81`, `8b36353`, `efe3b7c`, `49c184a` add immediate email execution and mailbox follow-through; `613268f` adds the LinkedIn relationship workflow; `92bd738`, `8308827`, `cd91474`, `a86e429` improve proactive/morning brief behavior. |
| Scoped behavior and input fixes | `a6ac9fc` activates read-only specialist routing; `fe7ed7a` recognizes spoken to-do-list phrases; `f9cd6ee` and `222ce42` correct common Deepgram misrecognitions; `abddad0` prevents real-name substitution into dictated/dream content. |
| UI | `23c17ea` adds the audio-reactive wireframe. This sweep also removes the in-app volume control and its gain/compressor path. |

Merge-only commits are represented by their merged feature above. The source
inventory is intentionally first-parent so it describes what reached `main`,
not abandoned branch work.

## Findings

### P0 — streamed preliminary replies can be spoken before the authoritative answer

`processOwnerText()` passes `onSentence` into every model round. A model may
emit assistant content in a round that also requests tools, or before a later
false-denial/action-receipt correction. The browser immediately synthesizes
each received `sentence` event. The final post-tool/correction response is then
also streamed and spoken. `createSentenceGate()` blocks known bad sentences,
but cannot retract an already emitted clean prefix.

Effect: AURA can verbally start an answer, then give a corrected or grounded
answer in the same owner turn. This directly explains reports that she speaks
twice; depending on timing it can sound like she is talking over herself.

Fix: stream only a response that is known final for the turn. Keep early speech
for tool-free turns; when tools are offered, buffer round-zero prose until it
is clear there are no tool calls, and discard every non-final round's prose.
Use a server-side `answer_generation`/round id in each stream event and have
the client reject stale generations as defense in depth. Add an integration
test for content + tool-call round followed by a final answer.

### P0 — preference confirmation is delayed, fragile, and invisible at capture time

The server queues automatic memory extraction only after it has completed and
persisted the assistant reply. The worker may run later. For a lower-confidence
preference, `MemoryV2` stores a pending candidate in `owner_profile_v1`; the
next owner turn must be a short, strict approval and must immediately follow an
assistant message containing the exact generated question. A normal follow-up
or `"do it"` does not confirm. The model is merely shown a pending-confirmation
prompt, so whether it asks the user is not deterministic.

Effect: a preference can appear to be accepted conversationally but not become
durable, or it can sit unseen until it expires. Conversely, model-assigned
confidence ≥0.9 saves automatically, which makes this safety/UX boundary
inconsistent.

Fix: make preference capture a first-class, synchronous state transition.
When the owner explicitly says “remember,” persist immediately and return a
receipt. For passive observations, create a durable pending record before the
reply and have the server append one deterministic confirmation question.
Accept a small explicit confirmation grammar, including “do it,” tied to a
candidate id rather than the exact previous assistant text. Expose pending,
failed, and persisted memory outcomes in an owner-visible Memory status view.

### P1 — profile writes are serialized only within one Node process

`MemoryV2.mutationQueue` and `SupabaseStateStore.profileWrite` serialize local
calls, but profile updates use read-modify-write on one JSON state row. They do
not compare `aura_state.updated_at` on write. A second Render instance, restart,
or another writer can overwrite entries/candidates written after its snapshot.
Memory extraction jobs do use compare-and-swap correctly, proving the codebase
already has the building block.

Fix: introduce `updateOwnerProfileWithCas(mutator)`, retry bounded conflicts,
and use it for entries, candidate changes, and deletions. Add a two-store
concurrency test that proves disjoint writes survive.

### P1 — live-memory failures are retried but not operationally surfaced

The durable extraction queue retries five times and records a final job failure,
but the owner has no summarized failure count, replay endpoint, or alert. The
health endpoint reports learning status, but that is not an actionable memory
ledger.

Fix: add a read-only `/api/memory/health` with queued/retry/failed counts and
last error code; add a protected replay for a failed message after inspection.
Alert only after a threshold so an outage does not create notification noise.

### P1 — proactive speech can enter while a user turn is still thinking

The proactive-alert handler ignores alerts only when `isSpeaking` or
`isListening`; it does not check `isProcessing`. An alert arriving after a user
turn begins but before first audio can take ownership of the voice queue. The
user response later appends behind it, producing unexpected double speech.

Fix: defer proactive alerts while any interactive turn is active
(`isProcessing || isListening || isSpeaking`), then deliver a coalesced alert
only after the turn reaches idle. Instrument deferred/dropped alerts.

### P1 — first-turn live-data requests could falsely deny available tools

The latency router correctly offered CCC/web tools for recognized intents, but
most private reads still used round-zero `tool_choice: auto`. The fast model
could answer without calling one. The reply gate then missed passive wording
such as “the CCC records aren't available in this session,” treated every
attempt as disqualifying even when its receipt succeeded, and deliberately
excluded `search_web` from detection along with execution. Direct MRR prefetch
made this worse: the server had already obtained valid metrics, then marked the
tool attempted and suppressed receipt-based correction. Separately, the local
service log contains real `WEB_SEARCH_DAILY_LIMIT` failures; those were being
described as missing-session capabilities instead of reached quota.

Effect: the owner had to repeat the same request before AURA would use a tool
that was already authorized and available, or could not distinguish a routing
mistake from a genuine daily search limit.

Fix: require a read-tool call on round zero for explicit live-data questions,
while keeping a named `search_web` call and its input/quota gates for public
lookups. Detect passive denials. Track failed and successful receipts
separately; reuse successful results without rerunning tools, and never retry
web search outside its screened main loop. Preserve error codes in receipts and
translate genuine quota/privacy/database failures into exact user-facing text.

### P2 — current client protection is local, not protocol-level

The browser uses `currentTurn` and a shared queue to suppress stale audio, but
stream events do not include a server response generation. This makes correct
behavior dependent on request abort timing and client bookkeeping.

Fix: include `turn_id`, `generation`, and a monotonically increasing
`sequence` in every sentence/done event. The browser should reject any event
that does not match the active id/generation.

### P2 — voice coverage is source-shape oriented, not behavior oriented

`test/voice_ui.test.js` proves code/text is present with regular expressions.
It cannot prove that two stream rounds produce one audible answer, an alert is
deferred, or an interrupted PCM buffer cannot restart.

Fix: extract a small pure playback state machine and test it with simulated
sentence streams, alerts, errors, cancellation, and exact expected transitions.
Run a browser smoke test on iOS Safari before releasing voice changes.

## Changes applied in this sweep

The in-app volume button and `aura_playback_volume` preference are removed. The
browser now relies on the device's native volume. Playback retains the analyser
for the visual wave but removes the adjustable GainNode and compressor, so both
streamed PCM and fallback `<audio>` use the same minimal output graph. Assets
were cache-busted as `20260820-reliability1` so installed PWAs fetch the change.

The P0/P1 reliability work and all five feature candidates are also implemented
as listed in the status table. Compatibility is deliberately one-way-safe: a
new browser accepts legacy stream events that omit fencing fields, while a new
server emits the fields for upgraded browsers.

## Remaining stabilization roadmap

1. **Burn in voice hardening:** deploy the final-answer buffer and stream fence,
   then review duplicate-speech, rejection, interruption, alert-deferral, and
   completion events for one week. Run an iOS Safari/Home Screen smoke test.
2. **Review memory state:** inspect pending candidates and failed jobs before
   replaying anything. Backfill no profile data automatically. Watch for
   `OWNER_PROFILE_CONFLICT`; repeated exhaustion indicates an abnormal writer.
3. **Make answer evaluation continuous:** collect a regression suite from actual failures
   (STT transcript, intended task, expected tool calls, allowed claim). Run it
   against Sol/Luna routing changes before deployment; use telemetry to measure
   first-round tool selection, tool failure, denial correction, and fallback
   rates by intent. Alert if an explicit live-data intent completes without a
   successful receipt or a precise failed receipt.
4. **Extend operator diagnostics:** the authenticated Control Center now renders
   reliability, memory, commitment, and watchlist state. Add persisted aggregate
   voice event counts after the initial log-only telemetry burn-in.
5. **Reduce operational blast radius further:** feature-flag future autonomy paths,
   retain reversible receipts for writes, add idempotency keys to every
   background action, and add a canary deploy that exercises chat, memory,
   calendar, reminders, and voice cancellation before promotion.

## Implemented feature surfaces

- **Memory control center:** the authenticated `/control.html` view pairs stored
  profile facts with pending preference decisions, extraction health, and
  guarded failed-job replay.
- **Answer cards with evidence:** compact voice-safe answer plus a tap-open
  receipt that names the data source, tool time, and freshness; this improves
  trust without making spoken replies verbose.
- **Client health watchlist:** deterministic, explainable phase/payment/activity
  signals with owner-configured thresholds—not an opaque score initially.
- **Email commitment inbox:** extract possible deadlines into a review queue;
  never create reminders/goals automatically until reviewed.
- **Daily reliability digest:** once per day, summarize failed tools, pending
  memory confirmations, review candidates, client signals, and stale integrations.

## Release gate

Do not add new autonomous writes until the following have held for at least a
week: no duplicate-audio traces in the browser state-machine telemetry; zero
unexplained profile-write conflicts; a reviewable outcome for every extraction
job; and regression-eval pass rates defined for the top real owner intents.
