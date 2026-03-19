-- Knowledge Base: documents + chunks with full-text search
-- Centralised company knowledge for AI tools (Sales Copilot, etc.)

create table if not exists public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  category text not null default 'other'
    check (category in ('chat_export', 'transcript', 'product_info', 'sales_script', 'faq', 'other')),
  source_type text not null default 'manual'
    check (source_type in ('upload', 'manual', 'imported')),
  description text not null default '',
  file_path text,
  original_filename text,
  content_text text not null default '',
  token_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'ready'
    check (status in ('processing', 'ready', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists kb_documents_user_idx on public.kb_documents(user_id, created_at desc);
create index if not exists kb_documents_category_idx on public.kb_documents(category);
create index if not exists kb_documents_status_idx on public.kb_documents(status);

create table if not exists public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.kb_documents(id) on delete cascade,
  chunk_index integer not null default 0,
  content text not null,
  token_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  search_vector tsvector,
  created_at timestamptz not null default now()
);

create index if not exists kb_chunks_document_idx on public.kb_chunks(document_id, chunk_index);
create index if not exists kb_chunks_search_idx on public.kb_chunks using gin(search_vector);

-- Auto-populate search_vector on insert/update
create or replace function kb_chunks_search_trigger() returns trigger as $$
begin
  new.search_vector :=
    setweight(to_tsvector('simple', coalesce(new.content, '')), 'A');
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_kb_chunks_search on public.kb_chunks;
create trigger trg_kb_chunks_search
  before insert or update of content on public.kb_chunks
  for each row execute function kb_chunks_search_trigger();

-- RLS
alter table public.kb_documents enable row level security;
alter table public.kb_chunks enable row level security;

-- All authenticated users can read all KB documents (company-wide knowledge)
drop policy if exists kb_documents_select on public.kb_documents;
create policy kb_documents_select
  on public.kb_documents for select to authenticated using (true);

drop policy if exists kb_documents_insert on public.kb_documents;
create policy kb_documents_insert
  on public.kb_documents for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists kb_documents_update on public.kb_documents;
create policy kb_documents_update
  on public.kb_documents for update to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

drop policy if exists kb_documents_delete on public.kb_documents;
create policy kb_documents_delete
  on public.kb_documents for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- Chunks inherit document visibility
drop policy if exists kb_chunks_select on public.kb_chunks;
create policy kb_chunks_select
  on public.kb_chunks for select to authenticated using (true);

drop policy if exists kb_chunks_insert on public.kb_chunks;
create policy kb_chunks_insert
  on public.kb_chunks for insert to authenticated
  with check (
    exists (
      select 1 from public.kb_documents
      where id = document_id and user_id = auth.uid()
    )
  );

drop policy if exists kb_chunks_delete on public.kb_chunks;
create policy kb_chunks_delete
  on public.kb_chunks for delete to authenticated
  using (
    exists (
      select 1 from public.kb_documents d
      where d.id = document_id
        and (
          d.user_id = auth.uid()
          or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
        )
    )
  );

-- RPC function for full-text search across chunks with document join
create or replace function public.kb_search_chunks(
  search_query text,
  filter_category text default null,
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
    ts_rank(c.search_vector, to_tsquery('simple', search_query)) as rank
  from public.kb_chunks c
  join public.kb_documents d on d.id = c.document_id
  where d.status = 'ready'
    and c.search_vector @@ to_tsquery('simple', search_query)
    and (filter_category is null or d.category = filter_category)
  order by rank desc
  limit result_limit
  offset result_offset;
$$;

-- Storage bucket for uploaded KB files
insert into storage.buckets (id, name, public)
values ('knowledge-base', 'knowledge-base', false)
on conflict (id) do nothing;

do $$
begin
  drop policy if exists kb_storage_insert on storage.objects;
  create policy kb_storage_insert
    on storage.objects for insert to authenticated
    with check (bucket_id = 'knowledge-base');

  drop policy if exists kb_storage_select on storage.objects;
  create policy kb_storage_select
    on storage.objects for select to authenticated
    using (bucket_id = 'knowledge-base');

  drop policy if exists kb_storage_delete on storage.objects;
  create policy kb_storage_delete
    on storage.objects for delete to authenticated
    using (bucket_id = 'knowledge-base');
exception
  when insufficient_privilege then
    raise notice 'Skipping storage.objects policies for knowledge-base: insufficient privileges.';
end $$;
