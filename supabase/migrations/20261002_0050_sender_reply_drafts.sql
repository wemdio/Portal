-- Персонализированные ответы внутри «Рассылки» (вкладка «Письма»):
-- ИИ пишет ответ лиду теми же правилами, что инструмент «Персонализированные
-- ответы», но по своим кампаниям «Рассылки» — без Instantly и без проектов.

-- ── Бриф, тон и пример у кампании ────────────────────────────────────────────
-- Необязательны: без брифа ИИ опирается на нашу цепочку писем в переписке и
-- на общую базу знаний персонализированных ответов.
alter table public.sender_campaigns
  add column if not exists reply_brief text not null default '',
  add column if not exists reply_tone text not null default '',
  add column if not exists reply_example text not null default '';

comment on column public.sender_campaigns.reply_brief is
  'Что продаём и кому — для ИИ-ответов лидам на вкладке «Письма». Пусто — ИИ берёт из нашей цепочки писем.';

-- ── Язык ответа у переписки ──────────────────────────────────────────────────
-- Выбор «Рус / Англ» переживает закрытие вкладки и смену сотрудника.
-- null — по умолчанию (английский для автоаутрича EN, иначе русский).
alter table public.sender_recipients
  add column if not exists reply_language text;
alter table public.sender_recipients
  drop constraint if exists sender_recipients_reply_language_check;
alter table public.sender_recipients
  add constraint sender_recipients_reply_language_check
  check (reply_language is null or reply_language in ('ru', 'en'));

-- ── Черновики ИИ ─────────────────────────────────────────────────────────────
create table if not exists public.sender_reply_drafts (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.sender_recipients(id) on delete cascade,
  campaign_id uuid not null references public.sender_campaigns(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'sent')),
  generated_text text not null,
  facts_used text,
  sources jsonb not null default '[]'::jsonb,
  language text not null default 'ru' check (language in ('ru', 'en')),
  model text,
  latency_ms int,
  -- Ответ, ушедший по этому черновику (с правками человека или без).
  manual_message_id uuid references public.sender_manual_messages(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_sender_reply_drafts_recipient
  on public.sender_reply_drafts (recipient_id, created_at desc);

alter table public.sender_reply_drafts enable row level security;
grant all on public.sender_reply_drafts to service_role;
