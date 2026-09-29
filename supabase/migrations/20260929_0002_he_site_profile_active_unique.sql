-- ENG / RU «Движок вертикалей» (he_*): один активный ЗАПУСК ИССЛЕДОВАНИЯ на
-- проект. Гонка двух почти одновременных POST .../projects/[id]/research
-- закрывается на уровне БД.
--
-- ЗАЧЕМ. `enqueueHeResearchJob` (app/src/lib/hypothesisEngine/researchJob.ts)
-- дедупит запуск ЧТЕНИЕМ «есть активная research-джоба?» до insert. Два
-- запроса, пришедшие в один момент (двойной клик специалиста, два открытых
-- таба, клиент и staff одновременно), проходят это чтение ОБА и вставляют две
-- джобы site_profile. Воркер односоточный, поэтому выполнит их по очереди — и
-- заплатит за стадию site_profile ДВА раза (фетч сайта + вызов модели), а
-- вторая перезапишет brief первой. Partial unique index пропускает только
-- первую вставку; проигравший insert получает 23505, и helper отдаёт тот же
-- `reason:'conflict'`, что и обычный дедуп → 409, а не 500.
--
-- ПОЧЕМУ ТОЛЬКО site_profile — это главное в этой миграции.
-- Широкий индекс (все research-стадии одной строкой, как в дедуп-чтении
-- helper'а) был бы ОПАСНЕЕ дефекта, который он лечит. Воркер дочейнивает
-- следующую стадию вставкой в he_jobs (app/worker/hypothesisEngine.ts,
-- `enqueueNextResearchStage`) уже ПОСЛЕ записи 'done' по завершённой стадии.
-- Широкий индекс дал бы на этой вставке 23505 по УЖЕ ОПЛАЧЕННОЙ стадии; до
-- волны 3 такой сбой уходил в failJob и возвращал done-джобу в 'pending' —
-- повторный платный прогон самой дорогой модели проекта. Сейчас
-- `chainNextResearchStage` такой сбой глотает, но цена всё равно есть: проект
-- уехал бы в 'failed' на ровном месте. Поэтому предикат — ровно одна стадия.
--
-- Индекс не может сработать ни на одной вставке ВОРКЕРА: `NEXT_RESEARCH_STAGE`
-- отображает site_profile → competitors и никогда обратно, других вставок
-- site_profile в дереве нет (единственная — в researchJob.ts). Не срабатывает
-- он и на возврате джобы в 'pending' (failJob, resetStuckJobs): 'running' и
-- 'pending' оба внутри предиката, строка остаётся в том же наборе, а второй в
-- нём быть не может — его и держит индекс.
--
-- ЧТО ДЕЛАЕТ МИГРАЦИЯ, ЕСЛИ ДУБЛИ УЖЕ ЕСТЬ. `create unique index` на таблице с
-- дублями падает сам, невнятным сообщением про existing key. Поэтому сначала
-- диагностика, и при находке миграция ОСТАНАВЛИВАЕТСЯ с понятной причиной.
-- Живую джобу она не удаляет и не отменяет НИЧЕГО: строка в 'running' — это
-- стадия, за которую уже платят прямо сейчас, а строка в 'pending' — работа,
-- которую кто-то ждёт; выбирать между ними за человека миграция не вправе.
-- Разбор руками (по одному проекту):
--
--   select project_id, id, status, attempts, started_at, created_at
--     from public.he_jobs
--    where stage = 'site_profile' and status in ('pending', 'running')
--    order by project_id, created_at;
--
-- Лишняя строка с `attempts = 0 and started_at is null` не сделала ничего и
-- платной работы не теряет — её и надо снять, оставив самую раннюю:
--
--   update public.he_jobs
--      set status = 'cancelled', finished_at = now(), updated_at = now()
--    where id = '<id лишней строки>';
--
-- Если у обеих строк проставлен `started_at`, обе уже оплачены: дождаться, пока
-- воркер их закончит (они уйдут в done/failed и из предиката выпадут), и
-- повторить деплой — доводить их руками не нужно.
--
-- ПРАВА. Новых ОБЪЕКТОВ (таблиц, функций) миграция не создаёт — только индекс,
-- а у индекса своих прав нет, он живёт правами `he_jobs` (та заперта от
-- anon/authenticated в 20260920_0001_he_rls_lockdown.sql и остаётся запертой).
-- Тот же довод, что в 20260730_0005_he_bases_collecting_unique.sql и
-- 20260926_0001_he_emails_per_company.sql: правилам app/src/lib/migrationLint.ts
-- (GRANT для service_role у новых таблиц, поимённый revoke у anon/authenticated
-- для новых объектов движков) в этом файле проверять нечего.
--
-- Миграция идёт в транзакции (маркера `migrate:no-transaction` нет): долларовые
-- кавычки do-блока сканер нетранзакционного режима не разбирает, а
-- `create index concurrently` тут и не нужен — he_jobs это очередь стадий,
-- десятки строк на проект, короткий ACCESS EXCLUSIVE незаметен. Повторный
-- прогон безопасен: `if not exists` + диагностика без записи.

-- Блокировка на запись до диагностики: иначе между проверкой и построением
-- индекса успела бы вставиться новая пара, и деплой упал бы сообщением
-- Postgres вместо нашего. Чтения не задеваются.
lock table public.he_jobs in share row exclusive mode;

do $$
declare
  affected_projects bigint;
  extra_jobs bigint;
begin
  -- sum() над bigint возвращает numeric, поэтому приводим явно: в bigint-переменную
  -- numeric лёг бы с округлением, а число здесь обязано быть точным.
  select count(*), coalesce(sum(cnt), 0)::bigint - count(*)
    into affected_projects, extra_jobs
    from (
      select project_id, count(*) as cnt
        from public.he_jobs
       where stage = 'site_profile'
         and status in ('pending', 'running')
       group by project_id
      having count(*) > 1
    ) as dup;

  if affected_projects > 0 then
    raise exception
      'Cannot install he_jobs_one_active_site_profile: % project(s) already have more than one active site_profile job (% extra row(s))',
      affected_projects, extra_jobs
      using hint =
        'Nothing was changed. List them with: select project_id, id, status, attempts, started_at, created_at from public.he_jobs where stage = ''site_profile'' and status in (''pending'', ''running'') order by project_id, created_at; keep the earliest row per project and cancel an extra row only while attempts = 0 and started_at is null. If two rows already started, let the worker finish them and re-run the deploy.';
  end if;
end $$;

create unique index if not exists he_jobs_one_active_site_profile
  on public.he_jobs (project_id)
  where stage = 'site_profile' and status in ('pending', 'running');

comment on index public.he_jobs_one_active_site_profile is
  'Одна активная джоба site_profile на проект: закрывает гонку двух запусков исследования (двойной платный прогон стадии). Только site_profile — остальные стадии воркер ставит сам ПОСЛЕ done предыдущей, и широкий индекс уронил бы оплаченную стадию.';
