-- Глобальные настройки тона и примера письма для генератора
-- персонализированных ответов (singleton, id=1 — как gis_signal_pipeline_config).
--
-- Логика приоритета (см. generateDraft.ts / buildPrompt.ts): если у проекта
-- заполнено своё поле тон/пример в reply_personalization_kb — используется оно,
-- иначе — глобальное. Новым проектам поля заполнять не обязательно: глобальные
-- значения покрывают их по умолчанию.
--
-- Редактирование — только руководителям (проверка роли в API-роуте),
-- чтение — всем, кому открыт инструмент.

create table if not exists public.reply_personalization_global_kb (
  id integer primary key default 1 check (id = 1),
  tone_notes text not null default '',
  example_case text not null default '',
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.reply_personalization_global_kb (id)
values (1)
on conflict (id) do nothing;

comment on table public.reply_personalization_global_kb is
  'Глобальный тон/ограничения и пример письма для генератора персонализированных ответов (singleton id=1). Приоритет: пер-проектное значение из reply_personalization_kb, при пустом поле — отсюда.';

alter table public.reply_personalization_global_kb enable row level security;

-- Как у per-project таблицы: доступ только через service-role из API-роутов.
create policy reply_personalization_global_kb_service_role
  on public.reply_personalization_global_kb
  for all to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.reply_personalization_global_kb to service_role;
