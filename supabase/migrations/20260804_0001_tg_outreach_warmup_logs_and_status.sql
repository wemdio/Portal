-- TG Outreach: отдельные логи прогрева + статус кампании «прогрев».
--
-- 1) Прогрев писал в общий tg_outreach_logs, и вкладка «Прогрев» показывала
--    вперемешку события прогрева и боевого цикла («круг завершён», «пауза
--    перед переходом к следующему аккаунту», SESSION_REVOKED). Читать это
--    невозможно: оператор открывает вкладку, чтобы понять состояние прогрева,
--    а видит поток кампании. Заводим свою таблицу.
--
-- 2) Прогрев и боевой аутрич взаимоисключающие, но в списке кампаний это никак
--    не было видно — кампания выглядела «остановленной». Отдельный статус
--    делает правило явным: либо греем аккаунты, либо работаем по лидам.

create table if not exists public.tg_outreach_warmup_logs (
  id          bigint generated always as identity primary key,
  run_id      uuid not null references public.tg_outreach_warmup_runs(id) on delete cascade,
  campaign_id uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  -- NULL = событие всего прогрева (начался день, завершён прогрев),
  -- иначе событие конкретного аккаунта.
  account_id  uuid references public.tg_outreach_accounts(id) on delete set null,
  level       text not null default 'info' check (level in ('info', 'warning', 'error')),
  message     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists tg_outreach_warmup_logs_run_idx
  on public.tg_outreach_warmup_logs (run_id, created_at desc);

create index if not exists tg_outreach_warmup_logs_account_idx
  on public.tg_outreach_warmup_logs (campaign_id, account_id, created_at desc);

comment on table public.tg_outreach_warmup_logs is
  'События прогрева. Намеренно отдельно от tg_outreach_logs: там поток боевого цикла, и во вкладке «Прогрев» он полностью заглушал события прогрева.';

-- Статус «прогрев». Воркер не подхватывает такие кампании в боевой auto-resume
-- (он смотрит только running/paused), а API отказывает в запуске аутрича.
alter table public.tg_outreach_campaigns
  drop constraint if exists tg_outreach_campaigns_status_check;
alter table public.tg_outreach_campaigns
  add constraint tg_outreach_campaigns_status_check
  check (status in ('stopped', 'running', 'paused', 'error', 'warming'));

alter table public.tg_outreach_warmup_logs enable row level security;

create policy tg_outreach_warmup_logs_select_all on public.tg_outreach_warmup_logs
  for select to authenticated using (true);

grant all on public.tg_outreach_warmup_logs to service_role;
grant select on public.tg_outreach_warmup_logs to authenticated;
