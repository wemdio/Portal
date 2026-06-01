-- Global tool visibility — админский «выключатель» инструмента для ВСЕХ
-- сразу (включая самого админа). Нужен чтобы прятать инструменты,
-- которые уже не актуальны/не готовы/устарели, без удаления из
-- toolsRegistry и без массового тыканья per-user тумблеров.
--
-- Логика (см. /api/user/tools и /api/admin/tool-visibility):
--   - строки нет ИЛИ enabled=true → fallback на текущую per-user логику
--     (DEFAULT_OFF_TOOL_IDS, DEFAULT_ON_TOOL_IDS_BY_ROLE,
--      user_tool_visibility).
--   - enabled=false → инструмент скрыт для ВСЕХ, включая admin.
--     Чтобы вернуть, admin идёт в шестерёнку и переключает обратно.

create table if not exists public.global_tool_visibility (
  tool_id text primary key,
  enabled boolean not null default true,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_global_tool_visibility_disabled
  on public.global_tool_visibility(tool_id) where enabled = false;

-- RLS: select всем authenticated (чтобы /api/user/tools читал под сессией
-- пользователя без service_role). Write — только через service_role
-- (админский API внутри проверяет роль и пишет через supabaseAdmin).
alter table public.global_tool_visibility enable row level security;

grant all on public.global_tool_visibility to service_role;
grant select on public.global_tool_visibility to authenticated;

drop policy if exists global_tool_visibility_select on public.global_tool_visibility;
create policy global_tool_visibility_select
  on public.global_tool_visibility for select
  to authenticated
  using (true);
