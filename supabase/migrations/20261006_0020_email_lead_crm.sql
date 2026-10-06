-- Email-аутрич: ответ, признанный лидом, сразу заводится сделкой в CRM.
--
-- Спека: docs/superpowers/specs/2026-10-06-email-outreach-polza-crm-design.md
--
-- То же, что у TG-аутрича (20261006_0010), но настройка живёт у проекта:
-- кампании Instantly привязаны к проектам, и квалификатор выносит вердикт
-- «лид» в контексте проекта. Первым включается наш проект «Polza» — его
-- кампании «1. Polza_…» и т. д.

-- 1. Настройка проекта. null — выключено.
--    { enabled, connection: 'polza' | <uuid crm_connections>, pipeline_id, status_id }
alter table public.projects
  add column if not exists crm_settings jsonb;

-- 2. Очередь. Колонки очереди совпадают с tg_outreach_crm_pushes — обе
--    разбирает lib/crm/dealQueue.ts.
create table if not exists public.email_lead_crm_pushes (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects(id) on delete cascade,
  -- id строки instantly_lead_qualifications (другая база — без внешнего ключа).
  qualification_id uuid not null,
  campaign_id      text,
  campaign_name    text not null default '',
  lead_email       text not null,
  lead_name        text,
  company_name     text,
  phone            text,
  connection       text not null,
  pipeline_id      bigint,
  status_id        bigint,
  message_text     text not null default '',
  status           text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  amo_lead_id      bigint,
  amo_contact_id   bigint,
  lead_url         text,
  error_message    text,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);

-- Одна сделка на почту в проекте: тот же человек, ответивший из другой
-- кампании или новым письмом, второй сделки не получает. Упавшая не мешает
-- повтору.
create unique index if not exists email_lead_crm_pushes_one_active_idx
  on public.email_lead_crm_pushes (project_id, lower(lead_email))
  where status in ('pending', 'sent');

create index if not exists email_lead_crm_pushes_pending_idx
  on public.email_lead_crm_pushes (next_attempt_at)
  where status = 'pending';

create index if not exists email_lead_crm_pushes_qualification_idx
  on public.email_lead_crm_pushes (qualification_id);

comment on table public.email_lead_crm_pushes is
  'Очередь создания сделок в CRM по лидам email-аутрича (вердикт квалификатора). Выполняет worker-tg-outreach (общий разборщик очередей CRM).';

alter table public.email_lead_crm_pushes enable row level security;

create policy email_lead_crm_pushes_select_all on public.email_lead_crm_pushes
  for select to authenticated using (true);

grant all on public.email_lead_crm_pushes to service_role;
grant select on public.email_lead_crm_pushes to authenticated;
