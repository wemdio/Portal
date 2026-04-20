-- Projects: client brief PDF attachment + AI-generated lead source hypotheses.
-- Adds storage bucket `briefs` (private) used by /api/projects/[id]/brief and the
-- existing brief-scoring flow (DatabaseSpreadsheet, base-constructor).

-- ── 1. Columns on public.projects ─────────────────────────────────────────────
alter table public.projects
  add column if not exists brief_file_path text,
  add column if not exists brief_file_name text,
  add column if not exists brief_text text,
  add column if not exists brief_uploaded_at timestamptz,
  add column if not exists lead_source_hypotheses text,
  add column if not exists lead_source_hypotheses_generated_at timestamptz,
  add column if not exists lead_source_hypotheses_error text;

-- ── 2. Storage bucket (private) ───────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('briefs', 'briefs', false)
on conflict (id) do update set public = excluded.public;

-- ── 3. Storage RLS for the briefs bucket ──────────────────────────────────────
-- Authenticated users may upload/read/delete files inside the briefs bucket.
-- Read access is also granted via signed URLs created server-side; we still
-- allow direct authenticated reads as a safety net (paths are random + bucket
-- is private, so URLs are not enumerable).
do $$
begin
  alter table storage.objects enable row level security;

  drop policy if exists briefs_authenticated_select on storage.objects;
  create policy briefs_authenticated_select
    on storage.objects
    for select
    to authenticated
    using (bucket_id = 'briefs');

  drop policy if exists briefs_authenticated_insert on storage.objects;
  create policy briefs_authenticated_insert
    on storage.objects
    for insert
    to authenticated
    with check (bucket_id = 'briefs');

  drop policy if exists briefs_authenticated_update on storage.objects;
  create policy briefs_authenticated_update
    on storage.objects
    for update
    to authenticated
    using (bucket_id = 'briefs')
    with check (bucket_id = 'briefs');

  drop policy if exists briefs_authenticated_delete on storage.objects;
  create policy briefs_authenticated_delete
    on storage.objects
    for delete
    to authenticated
    using (bucket_id = 'briefs');
exception
  when insufficient_privilege then
    raise notice 'Skipping storage.objects policies: insufficient privileges.';
end $$;
