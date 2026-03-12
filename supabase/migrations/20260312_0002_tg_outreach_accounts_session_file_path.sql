-- Allow storing path to .session file (TDesktop SQLite) in Supabase Storage
alter table public.tg_outreach_accounts
  add column if not exists session_file_path text;

comment on column public.tg_outreach_accounts.session_file_path is 'Storage path for .session file (bucket tg-outreach-sessions, path campaign_id/account_id.session)';

-- Bucket for .session files (private; access via service role or signed URL)
insert into storage.buckets (id, name, public)
values ('tg-outreach-sessions', 'tg-outreach-sessions', false)
on conflict (id) do update set public = excluded.public;
