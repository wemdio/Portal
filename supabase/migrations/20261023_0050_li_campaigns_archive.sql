-- LinkedIn Outreach: архив кампаний. Не null — кампания убрана из основного списка.
alter table public.li_campaigns
  add column if not exists archived_at timestamptz;
