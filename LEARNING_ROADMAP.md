# AURA Learning Roadmap

AURA's target is bounded lifelong learning: improve from experience without
silently expanding her permissions, rewriting application code, or treating
untrusted email/web/database content as owner instruction.

## What is live

- Structured owner memory for identity, people, preferences, pronunciations,
  business rules, and searchable durable facts.
- Hybrid pgvector and lexical recall, plus an always-on memory slice.
- Durable asynchronous fact extraction with retries.
- Rolling conversation summaries for continuity.
- Bundled procedural skills and owner-scoped learned skills in Supabase.
- Durable multi-turn reflection batches. AURA accumulates recent turn digests
  and tool outcomes across Render restarts, then reflects after the configured
  turn/tool threshold.
- Candidate-gated skill learning. Autonomous proposals remain invisible until
  a second model call replays at least two sanitized historical scenarios and
  deterministic policy checks pass. Patches must beat the active version.
- Learned skill lifecycle history retains candidates, active, retired, rejected,
  and rolled-back versions. Repeated failures automatically restore the prior
  learned version, bundled fallback, or disable the skill and alert the owner.
- An owner-scoped skill outcome ledger attributes every viewed skill version to
  the response's tool successes/failures. The immediately following owner turn
  records conservative positive/negative feedback or closes attribution as
  neutral; explicit feedback can override it. Reflection consumes this evidence.
- Notable episodic memory stores completed workflows, decisions, corrections,
  and failures separately from permanent owner facts. Episodes are available to
  semantic recall and later reflection but are excluded from always-on memory.
- Evidence-backed beliefs require two cited, real episode ids and confidence of
  at least 0.75. Conflicting evidence marks a belief contested instead of
  overwriting it; contested beliefs are surfaced as unresolved and can only be
  resolved by explicitly choosing a recorded statement.

## Next milestones

### 1. Outcome and feedback ledger — live

Records when a skill is selected, which version ran, its tool outcomes, whether
the owner corrected the result on the next turn, and explicit positive/negative
feedback. This gives reflection objective evidence instead of relying only on
model prose. Authenticated inspection and feedback endpoints are available under
`/api/learning/`.

Success gate met: every `view_skill` execution has an auditable outcome, and a
negative correction identifies the exact skill version(s) responsible.

### 2. Skill evaluation, promotion, and rollback — live

New procedures begin as candidates. Sanitized historical scenarios are replayed
in an independent evaluation, and deterministic checks reject secrets, prompt
injection, authorization bypasses, self-modification, and ungated external
actions. A candidate needs two passing scenarios and score >= 0.75; patches must
beat the active version by >= 0.05. Up to 20 versions are retained. Two negative
owner corrections or three hard failures in the last five uses automatically
roll back the exact active version and notify the owner.

Success gate met: no autonomous learned skill becomes active solely because one
model response suggested it, and every active learned version can fall back to a
prior learned version, bundled workflow, or disabled state.

### 3. Episodic memory and consolidation — core loop live

Raw episodes (what happened) are separate from semantic knowledge (what is
generally true). Reflection saves only notable events above the importance gate,
and later reflection can compare recent episodes. Repeated evidence can now
produce an owner-scoped belief with episode-level provenance, while conflicting
evidence creates an unresolved alternative rather than replacing the belief.
The remaining work is duplicate episode merging, retention, confidence reduction
for stale unsupported beliefs, and automated health/quality metrics.

Core gate met: AURA distinguishes a recent event from a durable rule, does not
pin episodes into the owner profile, can show why a belief exists, and surfaces
unresolved contradictions instead of silently choosing one.

### 4. Retrieval quality and memory observability — scoring and traces live

Recall now combines vector similarity, lexical overlap, named-entity overlap,
recency, and confidence, while filtering relevance on the unboosted match. A
private bounded retrieval ledger records the exact memories AURA injected, why
they matched, source, confidence, score components, and age. Existing memory
and profile correction endpoints provide the owner controls. Remaining work is
a visual in-app dashboard and a fixed retrieval evaluation set/benchmark.

Partial gate met: the owner can inspect or correct every traced influential
memory. Full completion still needs a fixed benchmark proving recall quality.

### 5. Bounded proactive planning

Let AURA propose and track multi-step internal plans from open commitments and
recurring patterns. Reads and internal organization may run autonomously;
external or destructive actions retain the existing current-turn authorization
and approval boundaries.

Success gate: AURA advances internal work without prompting while never treating
learned behavior as permission for an external action.

### 6. Capability self-model

Generate a runtime capability inventory from actually configured tools and
health checks. Use it to prevent false capability denials, distinguish temporary
provider outages from permanent inability, and guide which skills are usable.

Success gate: capability claims are grounded in live configuration and tool
availability rather than conversation summaries or persona text.

## Evaluation principles

- Learning quality is measured by task success, correction rate, retrieval
  precision, and avoided repeated mistakes—not by number of memories or skills.
- AURA may learn knowledge and procedure, never authorization.
- Private data stays out of public search and evaluation fixtures.
- Every learned artifact needs provenance, versioning, inspection, correction,
  and deletion.
- Failed experiences remain useful as pitfalls but do not count as proof that a
  workflow succeeds.
