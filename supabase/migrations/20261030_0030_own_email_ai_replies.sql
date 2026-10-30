-- Диалоговые ответы наших Instantly-кампаний: RU и EN включаются отдельно.
-- Письма до включения никогда не отправляются задним числом.
alter table public.own_reply_lead_settings
  add column if not exists ai_enabled_ru boolean not null default false,
  add column if not exists ai_enabled_en boolean not null default false,
  add column if not exists ai_enabled_at_ru timestamptz,
  add column if not exists ai_enabled_at_en timestamptz;

alter table public.own_reply_qualifications
  add column if not exists ai_reply_status text,
  add column if not exists ai_reply_attempts int not null default 0,
  add column if not exists ai_reply_next_attempt_at timestamptz not null default now();

create index if not exists own_reply_qualifications_ai_due_idx
  on public.own_reply_qualifications (ai_reply_next_attempt_at, reply_timestamp)
  where ai_reply_status is null and status in ('lead', 'not_lead');

create table if not exists public.own_reply_ai_turns (
  email_id text primary key references public.own_reply_qualifications(email_id) on delete cascade,
  campaign_id text not null,
  lead_email text not null,
  status text not null check (status in ('pending', 'sending', 'sent', 'review', 'closed', 'skipped')),
  decision text,
  intent text,
  objection text,
  case_id text,
  reply_text text,
  reason text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists own_reply_ai_turns_history_idx
  on public.own_reply_ai_turns (campaign_id, lead_email, created_at desc);
alter table public.own_reply_ai_turns enable row level security;
grant all on public.own_reply_ai_turns to service_role;
