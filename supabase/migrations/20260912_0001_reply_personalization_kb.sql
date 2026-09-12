-- База знаний проекта для инструмента «Персонализированные ответы на
-- входящие» (docs/superpowers/specs/2026-09-12-outreach-reply-personalization-design.md).
--
-- Одна строка на проект: бриф, факты о продукте, тон/ограничения, пример
-- хорошего письма — то, чем раньше был вручную веденный скилл
-- okdesk-personalized-replies, но параметризуемое под любой проект студии.
-- instantly_account_id — на каком Instantly-воркспейсе живут кампании этого
-- проекта (по умолчанию 'main'; для Okdesk будет отдельный id из
-- INSTANTLY_ACCOUNTS_JSON после того, как заведут ключ).
--
-- Изолирована от таблиц квалификатора входящих: ни FK, ни триггеров туда нет,
-- инструмент только читает их отдельно (см. db.ts).

create table if not exists public.reply_personalization_kb (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects(id) on delete cascade,
  brief text not null default '',
  product_facts text not null default '',
  tone_notes text not null default '',
  example_case text not null default '',
  instantly_account_id text not null default 'main',
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.reply_personalization_kb is
  'Карточка знаний проекта для генератора персонализированных ответов на входящие: бриф, факты о продукте, тон, пример письма. Одна строка на проект.';

alter table public.reply_personalization_kb enable row level security;

-- Доступ только через service-role из API-роутов инструмента (как у
-- instantly_lead_qualifications) — с браузера таблицу напрямую не читают.
create policy reply_personalization_kb_service_role on public.reply_personalization_kb
  for all to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.reply_personalization_kb to service_role;
