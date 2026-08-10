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
- Evidence-gated skill learning. Learned procedures carry a version,
  confidence, evidence, reason, and timestamps; unsupported or low-confidence
  skill changes are rejected.

## Next milestones

### 1. Outcome and feedback ledger

Record when a learned skill is selected, which version ran, its tool outcomes,
whether the owner corrected the result, and explicit positive/negative feedback.
This gives reflection objective evidence instead of relying only on model prose.

Success gate: every learned-skill execution has an auditable outcome, and a
negative correction can identify the exact skill version responsible.

### 2. Skill evaluation, promotion, and rollback

New procedures begin as candidates. Replay sanitized historical scenarios and
run deterministic policy checks before activation. Promote candidates that beat
the prior version; retain version history and automatically roll back repeated
failures.

Success gate: no learned skill becomes active solely because one model response
suggested it, and every active version can be rolled back.

### 3. Episodic memory and consolidation

Separate raw episodes (what happened) from semantic knowledge (what is generally
true). Periodically consolidate repeated episodes, merge duplicates, detect
contradictions, reduce confidence for stale unsupported beliefs, and preserve
provenance back to source episodes.

Success gate: AURA can explain why she believes a memory, distinguish a recent
event from a durable rule, and surface unresolved contradictions instead of
silently choosing one.

### 4. Retrieval quality and memory observability

Add temporal and importance weighting to vector similarity, entity-aware recall,
retrieval traces, and a private memory dashboard showing what was recalled,
why, confidence, source, age, and correction controls.

Success gate: benchmark recall improves on a fixed evaluation set, and the owner
can inspect or correct every influential memory.

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
