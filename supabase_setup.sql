-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).
-- It creates two read-only helper functions so AURA can introspect the schema
-- via supabase-js .rpc(), since PostgREST doesn't expose information_schema directly.

create or replace function aura_list_tables()
returns table(table_name text, table_type text)
language sql
security definer
set search_path = public
as $$
  select table_name, table_type
  from information_schema.tables
  where table_schema = 'public';
$$;

create or replace function aura_table_schema(p_table_name text)
returns table(column_name text, data_type text)
language sql
security definer
set search_path = public
as $$
  select column_name, data_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name = p_table_name;
$$;

-- Restrict execution to the service role only (AURA connects with the service key).
revoke all on function aura_list_tables() from public, anon, authenticated;
revoke all on function aura_table_schema(text) from public, anon, authenticated;
grant execute on function aura_list_tables() to service_role;
grant execute on function aura_table_schema(text) to service_role;
