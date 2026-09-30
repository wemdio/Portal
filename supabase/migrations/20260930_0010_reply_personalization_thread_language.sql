-- «Персонализированные ответы»: язык генерируемого письма — настройка чата.
--
-- До этого язык нигде не задавался: правила промпта, тон и примеры написаны
-- по-русски, поэтому на английскую переписку ИИ всё равно мог ответить
-- по-русски. Переключатель рус/англ живёт на конкретной переписке и виден
-- всем, кто её откроет (в браузере он бы остался только у одного сотрудника).
--
-- qualification_id — id строки instantly_lead_qualifications из ДРУГОЙ базы
-- (Instantly-датасет), поэтому uuid без внешнего ключа: так же сделано в
-- reply_personalization_drafts, см. её комментарий.
--
-- Строки нет вовсе = язык по умолчанию, русский. Пишем строку только когда
-- сотрудник переключил язык сам.

create table if not exists public.reply_personalization_thread_prefs (
  qualification_id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  language text not null default 'ru' check (language in ('ru', 'en')),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.reply_personalization_thread_prefs is
  'Настройки одной переписки в инструменте персонализированных ответов. Пока только язык письма: ru (по умолчанию) или en.';

comment on column public.reply_personalization_thread_prefs.language is
  'На каком языке ИИ пишет ответ в этой переписке. Отсутствие строки равно ru.';

create index if not exists reply_personalization_thread_prefs_project_idx
  on public.reply_personalization_thread_prefs (project_id);

alter table public.reply_personalization_thread_prefs enable row level security;

create policy reply_personalization_thread_prefs_service_role on public.reply_personalization_thread_prefs
  for all to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.reply_personalization_thread_prefs to service_role;
