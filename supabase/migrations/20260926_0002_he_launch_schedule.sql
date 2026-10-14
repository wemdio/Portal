-- Окно отправки, выбранное КЛИЕНТОМ английского кабинета для запуска шаблона
-- «Движка вертикалей»: часовой пояс, часы и дни недели.
--
-- Зачем таблица, а не поле в пресете рассылки (client_campaign_presets):
-- пресет заполняет администратор и он общий на все кампании клиента, а окно
-- выбирается НА ЗАПУСК (кабинет, api/client/eng/templates/[id]/launch и
-- .../schedule). Плюс пресеты лежат в instantly-postgres, а шаблоны движка —
-- в main-БД: ссылка на he_templates возможна только здесь.
--
-- Источник истины для отправки — расписание у рассыльщика: роут переставляет
-- его тем же campaign_schedule, что и остальной портал
-- (app/src/lib/clientLaunch/scheduleMapping.ts). Эта строка нужна, чтобы
-- кабинет показывал клиенту ЕГО выбор, не раскрывая id кампаний, и чтобы
-- правка окна и повторный запуск стартовали с выбранного значения, а не с
-- пресета администратора. Рассыльщика кабинет НЕ спрашивает, только пока эта
-- строка свежее записи о запуске (updated_at >= launch_info.created_at); иначе
-- (запуск сотрудником, force-перезапуск, неудавшаяся перестановка окна) строка
-- описывает прежние кампании, и GET .../schedule читает окно основной кампании
-- у рассыльщика.
--
-- Время храним как text 'ЧЧ:ММ', а не time: рассыльщик принимает ровно эту
-- строку (campaign_schedule.timing), а тип time вернулся бы через PostgREST как
-- '09:00:00' и потребовал бы обратного преобразования на каждом чтении.

create table if not exists public.he_launch_schedule (
  template_id       uuid primary key references public.he_templates(id) on delete cascade,
  -- Владелец на момент выбора: для аудита и прямых запросов staff. Скоуп
  -- запроса проверяет роут (he_templates → he_verticals → he_projects.created_by),
  -- поэтому чтение по template_id остаётся верным и после передачи проекта.
  client_user_id    uuid not null,
  schedule_timezone text not null check (schedule_timezone <> ''),
  schedule_from     text not null check (schedule_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  schedule_to       text not null check (schedule_to   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- Нумерация рассыльщика: 0=Sunday … 6=Saturday. Пустой набор означал бы
  -- «кампания не отправляется никогда» — такое окно клиенту не сохраняем.
  schedule_days     smallint[] not null
    check (array_length(schedule_days, 1) between 1 and 7
           and schedule_days <@ array[0,1,2,3,4,5,6]::smallint[]),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (schedule_from < schedule_to)
);

comment on table public.he_launch_schedule is
  'ENG-кабинет: окно отправки (пояс/часы/дни), выбранное клиентом при запуске шаблона движка вертикалей; 1:1 к he_templates.';

-- ─── Права ───────────────────────────────────────────────────────────────
-- Движковые таблицы (he_*/ve_*) браузер напрямую не читает — только API под
-- service_role. ALTER DEFAULT PRIVILEGES выдаёт anon/authenticated права на
-- каждую новую таблицу раннера миграций, поэтому отзываем их ПОИМЁННО
-- (20260920_0001_he_rls_lockdown.sql, линт app/tests/migrations/grants.test.ts).

alter table public.he_launch_schedule enable row level security;
revoke all privileges on table public.he_launch_schedule from public, anon, authenticated;
grant all on table public.he_launch_schedule to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_launch_schedule to readonly';
  end if;
end $$;
