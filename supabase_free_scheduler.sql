-- Reliable Blackboard scheduling for a sleeping Render Free web service.
--
-- Before running this file, add exactly two secrets in Supabase Dashboard:
--   Project Settings -> Vault
--
--   aura_deadline_origin
--     The deployed HTTPS origin only, such as https://aura-brain.onrender.com
--
--   aura_deadline_cron_secret
--     The same 64-character hexadecimal value configured as AURA_CRON_SECRET
--     in Render. Generate it outside SQL with: openssl rand -hex 32
--
-- Keeping the values in Vault prevents them from entering this migration or
-- Postgres cron.job. Phoenix remains UTC-7 all year, so 14:05 UTC is 7:05 AM.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
create extension if not exists supabase_vault with schema vault;

alter table public.aura_notifications
  add column if not exists dedupe_key text;

create unique index if not exists aura_notifications_owner_dedupe
  on public.aura_notifications(owner_id, dedupe_key)
  where dedupe_key is not null;

do $$
declare
  deadline_origin text;
  cron_secret text;
begin
  select decrypted_secret
    into strict deadline_origin
    from vault.decrypted_secrets
    where name = 'aura_deadline_origin';

  select decrypted_secret
    into strict cron_secret
    from vault.decrypted_secrets
    where name = 'aura_deadline_cron_secret';

  if deadline_origin !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$' then
    raise exception 'Vault secret aura_deadline_origin must be one HTTPS origin without a path';
  end if;

  if cron_secret !~ '^[0-9A-Fa-f]{64}$' then
    raise exception 'Vault secret aura_deadline_cron_secret must be exactly 64 hexadecimal characters';
  end if;
exception
  when no_data_found then
    raise exception 'Required AURA scheduler Vault secrets are missing';
  when too_many_rows then
    raise exception 'Each AURA scheduler Vault secret name must be unique';
end $$;

select cron.schedule(
  'aura-blackboard-deadlines-7am-phoenix',
  '5,10,15,20 14 * * *',
  $job$
    select net.http_post(
      url := rtrim(
        (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'aura_deadline_origin'
        ),
        '/'
      ) || '/internal/scheduled/blackboard-deadlines',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Accept', 'application/json',
        'X-Aura-Cron-Secret',
          (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'aura_deadline_cron_secret'
          )
      ),
      body := jsonb_build_object(
        'source', 'supabase_cron',
        'scheduled_at', now()
      ),
      timeout_milliseconds := 120000
    ) as request_id;
  $job$
);

-- Morning open-goals digest at 7:30 AM Phoenix (14:30 UTC). Retries a few
-- minutes later so a sleeping Render Free instance still gets woken.
select cron.unschedule(jobid)
from cron.job
where jobname = 'aura-daily-goals-730am-phoenix';

select cron.schedule(
  'aura-daily-goals-730am-phoenix',
  '30,35,40,45 14 * * *',
  $job$
    select net.http_post(
      url := rtrim(
        (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'aura_deadline_origin'
        ),
        '/'
      ) || '/internal/scheduled/daily-goals',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Accept', 'application/json',
        'X-Aura-Cron-Secret',
          (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'aura_deadline_cron_secret'
          )
      ),
      body := jsonb_build_object(
        'source', 'supabase_cron',
        'scheduled_at', now()
      ),
      timeout_milliseconds := 60000
    ) as request_id;
  $job$
);

-- Remove delivered Mail/Calendar payloads that a client did not pick up, while
-- retaining metadata about when and how the job completed.
select cron.schedule(
  'aura-companion-job-housekeeping',
  '15 * * * *',
  $job$
    do $cleanup$
    begin
      update public.aura_companion_jobs
      set result = null
      where result is not null
        and completed_at < now() - interval '1 hour';

      update public.aura_companion_jobs
      set error = null
      where error is not null
        and completed_at < now() - interval '1 day';

      update public.aura_companion_jobs
      set status = 'expired',
          completed_at = coalesce(completed_at, now())
      where status in ('queued', 'claimed')
        and expires_at < now();
    end
    $cleanup$;
  $job$
);
