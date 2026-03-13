-- CIS Lead Finder: storage bucket for uploaded lead files + job file metadata columns

-- Bucket for uploaded lead spreadsheets (private; processed server-side only)
insert into storage.buckets (id, name, public)
values ('cis-lead-imports', 'cis-lead-imports', false)
on conflict (id) do update set public = excluded.public;

alter table public.lead_import_jobs
  add column if not exists file_path text,
  add column if not exists file_mime text,
  add column if not exists file_size_bytes bigint;

