-- Faster semantic recall: store embeddings as pgvector and rank top-k in SQL
-- instead of pulling hundreds of jsonb vectors into Node on every turn.
-- Run once in the Supabase SQL Editor after the base aura_brain schema.

create extension if not exists vector;

alter table public.aura_memories
  add column if not exists embedding_vec vector(1536);

-- Backfill from existing jsonb embeddings (text-embedding-3-small = 1536 dims).
update public.aura_memories
set embedding_vec = (
  select array_agg(value::double precision order by ordinality)::vector(1536)
  from jsonb_array_elements_text(embedding) with ordinality as t(value, ordinality)
)
where embedding is not null
  and embedding_vec is null
  and jsonb_typeof(embedding) = 'array'
  and jsonb_array_length(embedding) = 1536;

create index if not exists aura_memories_embedding_vec_hnsw
  on public.aura_memories
  using hnsw (embedding_vec vector_cosine_ops);

create or replace function public.match_aura_memories(
  p_owner_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 6,
  p_match_threshold double precision default 0.32
)
returns table (
  id uuid,
  content text,
  kind text,
  source text,
  confidence double precision,
  created_at timestamptz,
  score double precision
)
language sql
stable
as $$
  select
    m.id,
    m.content,
    m.kind,
    m.source,
    m.confidence,
    m.created_at,
    (1 - (m.embedding_vec <=> p_query_embedding))::double precision as score
  from public.aura_memories m
  where m.owner_id = p_owner_id
    and m.superseded_by is null
    and m.embedding_vec is not null
    and (1 - (m.embedding_vec <=> p_query_embedding)) >= p_match_threshold
  order by m.embedding_vec <=> p_query_embedding
  limit greatest(1, least(coalesce(p_match_count, 6), 50));
$$;

revoke all on function public.match_aura_memories(uuid, vector, int, double precision) from public;
grant execute on function public.match_aura_memories(uuid, vector, int, double precision) to service_role;
