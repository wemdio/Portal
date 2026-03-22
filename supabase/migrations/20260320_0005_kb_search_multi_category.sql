-- Add filter_categories (text[]) parameter to kb_search_chunks
-- so the copilot can restrict search to relevant categories only.

create or replace function public.kb_search_chunks(
  search_query text,
  filter_category text default null,
  filter_categories text[] default null,
  result_limit integer default 20,
  result_offset integer default 0
)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_title text,
  category text,
  content text,
  rank real
)
language sql stable
as $$
  select
    c.id as chunk_id,
    d.id as document_id,
    d.title as document_title,
    d.category,
    c.content,
    ts_rank(c.search_vector, to_tsquery('russian', search_query)) as rank
  from public.kb_chunks c
  join public.kb_documents d on d.id = c.document_id
  where d.status = 'ready'
    and c.search_vector @@ to_tsquery('russian', search_query)
    and (filter_category is null or d.category = filter_category)
    and (filter_categories is null or d.category = any(filter_categories))
  order by rank desc
  limit result_limit
  offset result_offset;
$$;
