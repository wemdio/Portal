-- Ответы наших email-кампаний «N. Polza_…» → квалификация → сделка в AMO
-- (docs/superpowers/specs/2026-10-11-polza-email-reply-leads-amo-design.md).
--
-- Сами ответы лежат в базе Instantly (instantly_reply_inbox). Здесь — настройки
-- блока «Instantly · X. Polza», оценки ответов и очередь в нашу AMO, которую
-- разбирает общая очередь lib/crm/dealQueue.ts.

-- ── Настройки (одна строка) ──────────────────────────────────────────────────
create table if not exists public.own_reply_lead_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  -- Когда включили: ответы раньше этого момента не оцениваем.
  enabled_at timestamptz,
  -- null — общие правила квалификатора.
  lead_criteria text,
  -- Докуда прочитан instantly_reply_inbox: created_at (как строка из базы, с
  -- микросекундами) и email_id последней взятой строки.
  inbox_cursor_at text,
  inbox_cursor_id text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into public.own_reply_lead_settings (id) values (1) on conflict (id) do nothing;

alter table public.own_reply_lead_settings enable row level security;
grant all on public.own_reply_lead_settings to service_role;

-- ── Оценки ответов ───────────────────────────────────────────────────────────
create table if not exists public.own_reply_qualifications (
  email_id text primary key check (length(email_id) between 1 and 500),
  campaign_id text not null,
  campaign_name text not null default '',
  lead_email text not null,
  thread_id text,
  reply_subject text,
  reply_preview text,
  reply_timestamp timestamptz,
  -- pending — в работе или ждёт повтора; error — ИИ или Instantly не ответили за 5 попыток.
  status text not null default 'pending'
    check (status in ('pending', 'lead', 'not_lead', 'error', 'skipped')),
  ai_reason text,
  interest_signals text[] not null default '{}',
  criteria_used boolean not null default false,
  model text,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  qualified_at timestamptz,
  -- Лид, но в AMO не пошёл (этого человека уже передавали) — пояснение для истории.
  handoff_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_own_reply_qualifications_pending
  on public.own_reply_qualifications (next_attempt_at)
  where status = 'pending';
create index if not exists idx_own_reply_qualifications_created
  on public.own_reply_qualifications (created_at desc);

alter table public.own_reply_qualifications enable row level security;
grant all on public.own_reply_qualifications to service_role;

-- ── Очередь в AMO ────────────────────────────────────────────────────────────
-- Колонки очереди — те же, что у tg_outreach_crm_pushes (общая очередь
-- lib/crm/dealQueue.ts), плюс данные лида и доставка сообщения в ТГ.
create table if not exists public.own_reply_crm_pushes (
  id uuid primary key default gen_random_uuid(),
  qualification_id text not null references public.own_reply_qualifications(email_id) on delete cascade,
  connection text not null default 'polza',
  pipeline_id bigint,
  status_id bigint,
  lead_email text not null,
  lead_name text,
  company_name text,
  website text,
  campaign_name text not null default '',
  sub_source text not null default 'аутрич',
  message_text text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  -- created — новая сделка; note_added — переписка в уже открытую.
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

-- Один человек — одна передача. Упавшая задача повтор не блокирует.
create unique index if not exists own_reply_crm_pushes_one_per_email_idx
  on public.own_reply_crm_pushes (lower(lead_email))
  where status in ('pending', 'sent');
create index if not exists idx_own_reply_crm_pushes_pending
  on public.own_reply_crm_pushes (next_attempt_at)
  where status = 'pending';
create index if not exists idx_own_reply_crm_pushes_tg_due
  on public.own_reply_crm_pushes (next_attempt_at)
  where status = 'sent' and tg_sent_at is null;
create index if not exists idx_own_reply_crm_pushes_qualification
  on public.own_reply_crm_pushes (qualification_id);

alter table public.own_reply_crm_pushes enable row level security;
grant all on public.own_reply_crm_pushes to service_role;
