-- Compiled brief: short AI-ready summary of the entire knowledge base.
-- One row per company (singleton). Updated when KB content changes.

create table if not exists public.kb_compiled_brief (
  id text primary key default 'default',
  brief text not null default '',
  token_count integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.kb_compiled_brief (id) values ('default') on conflict do nothing;

alter table public.kb_compiled_brief enable row level security;

drop policy if exists kb_brief_select on public.kb_compiled_brief;
create policy kb_brief_select
  on public.kb_compiled_brief for select to authenticated using (true);

drop policy if exists kb_brief_update on public.kb_compiled_brief;
create policy kb_brief_update
  on public.kb_compiled_brief for update to authenticated
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

drop policy if exists kb_brief_insert on public.kb_compiled_brief;
create policy kb_brief_insert
  on public.kb_compiled_brief for insert to authenticated
  with check (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );
