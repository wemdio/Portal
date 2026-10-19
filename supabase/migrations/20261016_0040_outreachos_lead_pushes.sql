-- Заявки OutreachOS → сделка в нашей AMO → сообщение в «Продажи Polza» (General).
--
-- Два источника (решение пользователя 16.10.2026):
--   reply        — ответ по кампании кабинета OutreachOS (outreachos@test.ru),
--                  который квалификатор признал лидом; бот кабинета получает
--                  его как раньше;
--   registration — регистрация в кабинете или заявка с лендинга OutreachOS
--                  (всё, что уходит в бота регистраций).
-- Сделка — как их заводили руками: «Воронка - новые лиды», Источник
-- «Автоаутрич», Подысточник «OutreachOS», ответственная Юлия Миронова.
-- Разбирает общая очередь lib/crm/dealQueue.ts; сообщение в чат уходит после
-- AMO, уже со ссылкой на сделку.
create table if not exists public.outreachos_lead_pushes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('reply', 'registration')),
  -- Повтор той же заявки (перезапуск квалификации, двойная отправка формы) второй задачи не создаёт.
  dedupe_key text not null unique check (length(dedupe_key) between 1 and 600),
  connection text not null default 'polza',
  pipeline_id bigint,
  status_id bigint,
  lead_email text not null,
  lead_name text,
  company_name text,
  website text,
  campaign_name text not null default '',
  -- Сообщение для General без ссылки на сделку: ссылку дописывает доставка.
  tg_html text not null,
  -- Примечание в сделку AMO.
  message_text text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  action text check (action is null or action in ('created', 'note_added')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  amo_contact_id bigint,
  amo_lead_id bigint,
  amo_lead_name text,
  lead_url text,
  error_message text,
  sent_at timestamptz,
  tg_sent_at timestamptz,
  tg_message_id bigint,
  tg_attempts int not null default 0,
  tg_error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_outreachos_lead_pushes_pending
  on public.outreachos_lead_pushes (next_attempt_at)
  where status = 'pending';
create index if not exists idx_outreachos_lead_pushes_tg_due
  on public.outreachos_lead_pushes (created_at)
  where status in ('sent', 'failed') and tg_sent_at is null;

alter table public.outreachos_lead_pushes enable row level security;
grant all on public.outreachos_lead_pushes to service_role;
