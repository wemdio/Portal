-- Видимость инструментов по пользователям. По умолчанию (нет записей) — все инструменты включены.
create table if not exists public.user_tool_visibility (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  tool_id text not null,
  enabled boolean not null default true,
  unique(user_id, tool_id)
);

create index if not exists idx_user_tool_visibility_user_id on public.user_tool_visibility(user_id);

comment on table public.user_tool_visibility is 'Включение/выключение отображения инструментов для пользователя. Отсутствие строки для пары (user_id, tool_id) означает включено.';
