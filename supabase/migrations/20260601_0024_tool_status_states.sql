-- Расширяем `global_tool_visibility` из boolean on/off (0023) в 5-значный статус:
--
--   active          — нормально, без плашки
--   new             — активен + плашка «Новое». Авто-снятие через 7 дней —
--                     `app/scripts/db/cleanupExpiredToolStatuses.js`
--                     запускается в `.semaphore/scheduled-deploy.yml`. Чтение
--                     UI'я тоже учитывает истечение (на случай если деплой
--                     ещё не прошёл) — см. effectiveToolStatus в lib/toolStatus.ts.
--   beta            — активен + плашка «BETA», без срока истечения
--   in_development  — серая карточка с плашкой «В разработке», некликабельна
--   disabled        — скрыт у всех, включая admin (виден только в шестерёнке)

alter table public.global_tool_visibility
  add column if not exists status text default 'active'
    check (status in ('active','new','beta','in_development','disabled'));

alter table public.global_tool_visibility
  add column if not exists new_since timestamptz;

-- Перенос данных из старой `enabled boolean` → новый `status text`.
-- Делается ТОЛЬКО для строк, оставшихся в дефолтном 'active' — то есть
-- наша добавочная колонка только что появилась. Если кто-то уже руками
-- проставил status, не топчем.
update public.global_tool_visibility
  set status = case when enabled is false then 'disabled' else 'active' end
  where status = 'active';

alter table public.global_tool_visibility
  alter column status set not null;

-- enabled больше не нужен — UI пишет status.
alter table public.global_tool_visibility
  drop column if exists enabled;

-- Старый partial index ссылался на `enabled` — пересоздаём под `status`.
drop index if exists idx_global_tool_visibility_disabled;
create index if not exists idx_global_tool_visibility_non_active
  on public.global_tool_visibility(tool_id) where status <> 'active';
