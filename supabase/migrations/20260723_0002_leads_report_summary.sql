-- Подписчики пятничного Telegram-отчёта продаж.
-- Админы задаются через LEADS_REPORT_TG_ADMIN_IDS и получают отчёт всегда;
-- здесь хранятся только дополнительные получатели.

create table if not exists public.leads_report_subscribers (
  chat_id     bigint primary key,
  username    text,
  first_name  text,
  added_by    bigint not null,
  added_at    timestamptz not null default now()
);

comment on table public.leads_report_subscribers is
  'Получатели пятничного Telegram-отчёта продаж. Управляются администраторами через бота.';

alter table public.leads_report_subscribers enable row level security;

drop policy if exists leads_report_subscribers_select_auth
  on public.leads_report_subscribers;
create policy leads_report_subscribers_select_auth
  on public.leads_report_subscribers
  for select
  using (auth.uid() is not null);

grant all on public.leads_report_subscribers to service_role, postgres;

alter table public.external_sync_runs
  drop constraint if exists external_sync_runs_source_check;

alter table public.external_sync_runs
  add constraint external_sync_runs_source_check
  check (source in (
    'metrika',
    'amo_leads',
    'amo_events',
    'bank_tochka',
    'bank_tbank',
    'attribution',
    'amo_enrich',
    'leads_report_marketing',
    'leads_report_outreach',
    'leads_report_summary'
  ));
