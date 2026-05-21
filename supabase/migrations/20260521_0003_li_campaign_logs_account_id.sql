-- li-outreach: tie campaign log lines back to the LinkedIn account they came
-- from. Previously the only attribution was a fuzzy mention of the
-- unipile_account_id inside the message text, which made per-account log
-- views and error counters impossible without ILIKE searches.
--
-- The column is nullable because pre-existing rows have no account context
-- and because some early lines (e.g. "Тик пропущен — нет Unipile settings")
-- are emitted before the account row is loaded.

alter table public.li_campaign_logs
  add column if not exists account_id uuid references public.li_accounts(id) on delete set null;

create index if not exists li_campaign_logs_account_created_idx
  on public.li_campaign_logs (account_id, created_at desc)
  where account_id is not null;

comment on column public.li_campaign_logs.account_id is
  'LinkedIn account that produced this log line (li_accounts.id). NULL for lines emitted before the per-tick account is loaded, or for legacy rows.';
