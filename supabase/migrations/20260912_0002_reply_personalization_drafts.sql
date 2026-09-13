-- Журнал сгенерированных/отправленных/пропущенных ответов для инструмента
-- «Персонализированные ответы на входящие».
--
-- qualification_id — id строки instantly_lead_qualifications (Instantly-
-- датасет, отдельная БД от этой): FK невозможен между базами, поэтому просто
-- uuid без внешнего ключа, как это уже сделано для project_id в
-- project_instantly_campaigns (см. её комментарий "projects table is in main
-- DB").
--
-- Строка со статусом 'skipped' может не иметь текста вовсе (сотрудник
-- пропустил письмо, ни разу не сгенерировав ответ) — generated_text nullable.
--
-- Статус «обработано» для этого инструмента живёт только здесь: письмо
-- считается отправленным, если по его qualification_id есть строка со
-- status='sent'. Таблицы квалификатора эта запись не трогает.

create table if not exists public.reply_personalization_drafts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  qualification_id uuid not null,
  campaign_id text not null,
  thread_id text,
  lead_email text not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'skipped')),
  generated_text text,
  facts_used text,
  sources jsonb not null default '[]'::jsonb,
  context_complete boolean not null default true,
  model text,
  latency_ms integer,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

comment on table public.reply_personalization_drafts is
  'Журнал черновиков/отправок/пропусков инструмента персонализированных ответов. Статус sent = письмо реально ушло через кнопку «Отправить» — это и есть «обработано» в списке слева.';

create index if not exists reply_personalization_drafts_project_idx
  on public.reply_personalization_drafts (project_id, created_at desc);

create index if not exists reply_personalization_drafts_qualification_idx
  on public.reply_personalization_drafts (qualification_id, created_at desc);

alter table public.reply_personalization_drafts enable row level security;

create policy reply_personalization_drafts_service_role on public.reply_personalization_drafts
  for all to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.reply_personalization_drafts to service_role;
