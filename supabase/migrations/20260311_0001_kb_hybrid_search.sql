-- Enable pgvector for semantic search
create extension if not exists vector with schema extensions;

-- Add embedding column to kb_chunks (1536 dimensions for text-embedding-3-small)
alter table public.kb_chunks
  add column if not exists embedding vector(1536);

-- HNSW index for fast cosine similarity search
create index if not exists kb_chunks_embedding_idx
  on public.kb_chunks
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Hybrid search: combines FTS rank + cosine similarity
-- Returns best results from either method, de-duplicated and merged
create or replace function public.kb_hybrid_search(
  query_text text,
  query_embedding vector(1536),
  filter_categories text[] default null,
  match_limit integer default 5,
  fts_weight real default 1.0,
  semantic_weight real default 1.0
)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_title text,
  category text,
  content text,
  fts_rank real,
  similarity real,
  combined_score real
)
language sql stable
as $$
  with fts as (
    select
      c.id,
      ts_rank(c.search_vector, to_tsquery('russian', query_text)) as fts_rank
    from public.kb_chunks c
    join public.kb_documents d on d.id = c.document_id
    where d.status = 'ready'
      and c.search_vector @@ to_tsquery('russian', query_text)
      and (filter_categories is null or d.category = any(filter_categories))
    order by fts_rank desc
    limit match_limit * 2
  ),
  semantic as (
    select
      c.id,
      1 - (c.embedding <=> query_embedding) as similarity
    from public.kb_chunks c
    join public.kb_documents d on d.id = c.document_id
    where d.status = 'ready'
      and c.embedding is not null
      and (filter_categories is null or d.category = any(filter_categories))
    order by c.embedding <=> query_embedding
    limit match_limit * 2
  ),
  combined as (
    select
      coalesce(f.id, s.id) as id,
      coalesce(f.fts_rank, 0.0)::real as fts_rank,
      coalesce(s.similarity, 0.0)::real as similarity,
      (coalesce(f.fts_rank, 0.0) * fts_weight
        + coalesce(s.similarity, 0.0) * semantic_weight)::real as combined_score
    from fts f
    full outer join semantic s on f.id = s.id
  )
  select
    c.id as chunk_id,
    d.id as document_id,
    d.title as document_title,
    d.category,
    c.content,
    cb.fts_rank,
    cb.similarity,
    cb.combined_score
  from combined cb
  join public.kb_chunks c on c.id = cb.id
  join public.kb_documents d on d.id = c.document_id
  order by cb.combined_score desc
  limit match_limit;
$$;
