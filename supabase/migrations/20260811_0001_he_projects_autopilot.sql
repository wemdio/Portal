-- Флаг «автопилота» ENG-кабинета Движка вертикалей: при autopilot=true воркер
-- сам дочейнит конвейер chain → base_collect → (base_analyze авто) → template
-- после каждой done-стадии (lib/hypothesisEngine/autopilotNext.ts), а кабинет
-- показывает единое окно Review & Launch. Флаг ставит
-- POST /api/client/eng/projects/[id]/autopilot.
-- Дефолт false — поведение существующих RU-проектов (ручные кнопки) не меняется.
alter table public.he_projects
  add column if not exists autopilot boolean not null default false;
