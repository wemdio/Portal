-- Reglament documents
create table if not exists public.reglament_documents (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  title text not null,
  status text not null default 'draft'
    check (status in ('draft', 'published')),
  content jsonb not null default '{}'::jsonb,
  cover_image_url text,
  summary text,
  order_index integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

create unique index if not exists idx_reglament_documents_slug on public.reglament_documents(slug);
create index if not exists idx_reglament_documents_status on public.reglament_documents(status);
create index if not exists idx_reglament_documents_order on public.reglament_documents(order_index, created_at desc);
create index if not exists idx_reglament_documents_updated on public.reglament_documents(updated_at desc);

alter table public.reglament_documents enable row level security;

-- Published documents are readable by authenticated users
drop policy if exists reglament_documents_select_published on public.reglament_documents;
create policy reglament_documents_select_published
  on public.reglament_documents
  for select
  to authenticated
  using (status = 'published');

-- Admins can read all documents
drop policy if exists reglament_documents_admin_select on public.reglament_documents;
create policy reglament_documents_admin_select
  on public.reglament_documents
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );

-- Admins can insert documents
drop policy if exists reglament_documents_admin_insert on public.reglament_documents;
create policy reglament_documents_admin_insert
  on public.reglament_documents
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );

-- Admins can update documents
drop policy if exists reglament_documents_admin_update on public.reglament_documents;
create policy reglament_documents_admin_update
  on public.reglament_documents
  for update
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );

-- Admins can delete documents
drop policy if exists reglament_documents_admin_delete on public.reglament_documents;
create policy reglament_documents_admin_delete
  on public.reglament_documents
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );
