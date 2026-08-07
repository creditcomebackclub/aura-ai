---
name: aura-workflows
description: Index of AURA procedural skills. Runtime skills live under skills/bundled and skills/learned; this file is the human/docs entry point.
---

# AURA Workflows

Procedural runbooks used at runtime are progressive-disclosure skill packages:

- `skills/bundled/<name>/SKILL.md` — seeded CCC workflows (read-only to the agent)
- `skills/learned/<name>/SKILL.md` — agent-created or patched procedures

At chat time AURA sees only a **name + description index**. Full bodies load via the `view_skill` tool. New reusable procedures are written with `manage_skill` into `skills/learned/` only.

Bundled skills today:

1. `named-client-lookup`
2. `actionable-ccc-sweep`
3. `test-letter-deletion`
4. `owner-messaging`
5. `blackboard-deadlines`

Tool schemas and authorization still live in `server.js` / `agent_policy.js` / `SOUL.md`. This file is documentation and discovery for humans; do not treat it as the live prompt payload.
