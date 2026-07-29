-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).
--
-- Lets AURA delete scratch/test letters and records each deletion in the
-- EXISTING aura_actions audit table, which already models propose -> approve ->
-- execute. No new audit table is needed.
--
-- Note this is deliberately not the "deletions" table: that one is business data
-- for credit-report deletions (fee_amount, nmi_transaction_id, ...) and must not
-- be used as an application audit log.

-- 1. Allow a destructive risk level on both the action log and the agent registry.
alter table public.aura_actions drop constraint if exists aura_actions_risk_level_check;
alter table public.aura_actions add constraint aura_actions_risk_level_check
  check (risk_level in ('read', 'reversible_write', 'external_action', 'destructive_write'));

alter table public.aura_agents drop constraint if exists aura_agents_maximum_risk_check;
alter table public.aura_agents add constraint aura_agents_maximum_risk_check
  check (maximum_risk in ('read', 'reversible_write', 'external_action', 'destructive_write'));

-- 2. Register AURA herself as the actor, so every deletion is attributable.
insert into public.aura_agents (id, name, description, instructions, allowed_tools, maximum_risk, enabled)
values (
  'aura_core',
  'AURA',
  'AURA acting directly on the owner''s spoken instruction.',
  'May delete scratch/test letters only, and only after the owner explicitly confirms the specific record.',
  '["list_deletable_test_letters", "propose_test_letter_deletion", "confirm_test_letter_deletion"]'::jsonb,
  'destructive_write',
  true
)
on conflict (id) do update
  set maximum_risk = excluded.maximum_risk,
      allowed_tools = excluded.allowed_tools,
      description = excluded.description,
      instructions = excluded.instructions,
      updated_at = now();
