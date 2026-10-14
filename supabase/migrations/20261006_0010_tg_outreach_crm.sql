-- TG-аутрич: переданный лид сразу заводится сделкой в CRM.
--
-- Спека: docs/superpowers/specs/2026-10-06-tg-outreach-crm-handoff-design.md
--
-- Лид, переданный менеджеру карточкой в Telegram, в AMO до сих пор заносили
-- руками — а по правилу «каждая сделка в AMO» без этого он не попадает в
-- отчёты продаж. Теперь у кампании есть блок «Передавать в CRM»: наша AMO
-- (Polza) или amoCRM клиента, если кампания ведётся для него.

-- 1. Подключения к amoCRM клиентов.
--
-- Нашу AMO сюда не кладём: она одна, её токен уже лежит в env сервера
-- (AMO_ACCESS_TOKEN) и им пользуется весь остальной портал. В настройках
-- кампании она адресуется строкой 'polza'.
--
-- Токен клиента хранится зашифрованным (AES-256-GCM, ключ CRM_CRED_KEY) и
-- наружу не отдаётся: политик для authenticated нет, ходят только API-роуты
-- под service_role и воркер.
create table if not exists public.crm_connections (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  kind             text not null default 'amocrm' check (kind = 'amocrm'),
  base_url         text not null,
  secret_encrypted text not null,
  status           text not null default 'ok' check (status in ('ok', 'error')),
  last_verified_at timestamptz,
  last_error       text,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.crm_connections is
  'Подключения к amoCRM клиентов для передачи лидов TG-аутрича. Токен зашифрован, читается только через service_role.';

alter table public.crm_connections enable row level security;

grant all on public.crm_connections to service_role;

-- 2. Настройка кампании. null — передача в CRM выключена.
--    { enabled, connection: 'polza' | <uuid crm_connections>, pipeline_id, status_id }
alter table public.tg_outreach_campaigns
  add column if not exists crm_settings jsonb;

-- 3. Очередь отправки в CRM.
--
-- Отдельная от очереди передач в Telegram: сбой AMO не должен мешать лиду
-- дойти до менеджера в чат, а у CRM свои повторы и свои причины отказа.
-- Настройки и карточку снимаем на момент постановки — смена воронки в
-- кампании не переносит уже поставленного лида.
create table if not exists public.tg_outreach_crm_pushes (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  dialog_id       uuid not null references public.tg_outreach_dialogs(id) on delete cascade,
  -- 'polza' или id из crm_connections (без внешнего ключа: 'polza' — не строка таблицы).
  connection      text not null,
  pipeline_id     bigint,
  status_id       bigint,
  campaign_name   text not null default '',
  username        text,
  tg_user_id      bigint,
  offer           text,
  message_text    text not null default '',
  status          text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  amo_lead_id     bigint,
  amo_contact_id  bigint,
  lead_url        text,
  error_message   text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

-- Одна живая или созданная сделка на диалог: повторная передача того же
-- человека не заводит вторую сделку. Упавшая не блокирует повтор.
create unique index if not exists tg_outreach_crm_pushes_one_active_idx
  on public.tg_outreach_crm_pushes (dialog_id)
  where status in ('pending', 'sent');

create index if not exists tg_outreach_crm_pushes_pending_idx
  on public.tg_outreach_crm_pushes (next_attempt_at)
  where status = 'pending';

create index if not exists tg_outreach_crm_pushes_dialog_idx
  on public.tg_outreach_crm_pushes (dialog_id, created_at desc);

comment on table public.tg_outreach_crm_pushes is
  'Очередь создания сделок в CRM по переданным лидам TG-аутрича. Выполняет worker-tg-outreach.';

alter table public.tg_outreach_crm_pushes enable row level security;

-- Читать статус может вся команда (как у tg_outreach_lead_forwards); пишут
-- только воркер и API-роуты под service_role.
create policy tg_outreach_crm_pushes_select_all on public.tg_outreach_crm_pushes
  for select to authenticated using (true);

grant all on public.tg_outreach_crm_pushes to service_role;
grant select on public.tg_outreach_crm_pushes to authenticated;
