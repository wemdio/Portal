-- ENG / RU «Движок вертикалей» (he_*): не больше ОДНОЙ активной джобы
-- генерации шаблона (stage = 'template') и ОДНОЙ активной джобы анализа
-- (stage = 'base_analyze') на базу. Активная — status 'pending' или 'running';
-- остальные статусы he_jobs ('done', 'failed', 'cancelled', ограничение
-- he_jobs_status_check из 20260803_0002) в предикат не входят.
--
-- ЗАЧЕМ. Обе стадии платные (вызовы модели), и все их постановки дедупят ЧТЕНИЕМ
-- «активная джоба этой стадии по этой базе уже есть?» до insert. Два запроса в
-- один момент проходят это чтение ОБА и вставляют две джобы:
--   - двойной клик «Generate template» (POST api/client/eng/bases/[id]/template)
--     или «Собрать шаблон» специалиста (POST api/tools/hypothesis-engine/bases/[id]/template);
--   - автопилот (afterBaseAnalyzeDone в app/src/lib/hypothesisEngine/autopilotNext.ts)
--     и клиент или кнопка «Start outreach» (autopilotReconcile.ts) по одной базе;
--   - ремонт осиротевшей 'analyzing'-базы (repairOrphanAnalyzingBase) из двух
--     контуров сразу и постановка анализа финалом сборки (ensureBaseAnalyzeJob,
--     stages/baseCollect.ts).
-- Воркер один и берёт джобы по очереди, поэтому обе строки исполнятся — и до
-- этой волны каждая платила полный прогон. Partial unique index пропускает
-- первую вставку; проигравшая получает 23505.
--
-- МЕСТА ВСТАВКИ И ИХ ОТВЕТ НА 23505 (других вставок этих стадий в дереве нет):
--   template:
--     - api/client/eng/bases/[id]/template — 200 с уже стоящей джобой;
--     - api/tools/hypothesis-engine/bases/[id]/template — 200 с уже стоящей;
--     - autopilotNext.ts afterBaseAnalyzeDone — итог 'existing';
--     - autopilotReconcile.ts (кнопка «Start outreach» и ночной проход) —
--       пропуск 'template_running', паузы нет;
--   base_analyze:
--     - autopilotNext.ts repairOrphanAnalyzingBase (его зовут дочейн, кнопка
--       «Start outreach», ночной проход и ремонт воркера) — итог 'reanalyzed';
--     - stages/baseCollect.ts ensureBaseAnalyzeJob — итог 'existing';
--     - api/tools/hypothesis-engine/projects/[id]/bases (загрузка CSV) — после
--       любого отказа вставки перечитывает строку и находит уже стоящую.
--
-- ПОЧЕМУ ВОРКЕР НА ИНДЕКС НЕ НАТКНЁТСЯ ВНЕ ГОНКИ. Каждое место вставки выше
-- сначала читает активные строки этой стадии по базе, а загрузка CSV ставит
-- анализ только СВОЕЙ новой базе. Возврат строки в очередь (failJob,
-- resetStuckJobs) двигает ТУ ЖЕ строку между 'running' и 'pending' — обе внутри
-- предиката, второй строки не появляется. Дочейн research-стадий
-- (enqueueNextResearchStage) этих стадий не ставит. То есть индекс срабатывает
-- ровно на гонке двух постановок, а не на оплаченной стадии.
--
-- ПОЧЕМУ ЗДЕСЬ НЕТ ИНДЕКСА НА RESEARCH. «Одно активное исследование на проект»
-- уже держит he_jobs_one_active_site_profile (20260929_0002) — единственная
-- точка входа в цепочку (researchJob.ts) ставит только site_profile, остальные
-- стадии ставит воркер ПОСЛЕ 'done' предыдущей. Широкий индекс по всем
-- research-стадиям дал бы 23505 на этой вставке воркера, то есть по уже
-- оплаченной стадии (доводы — в шапке 20260929_0002). Остаток — окно между
-- 'done' стадии и вставкой следующей, где чтение researchJob.ts не видит
-- активной строки; закрыть его индексом нельзя по той же причине.
--
-- ЧТО СДЕЛАТЬ ДО ДЕПЛОЯ — ТОЛЬКО ЧТЕНИЕ, ничего не меняет:
--
--   select stage, payload->>'base_id' as base_id, count(*) as active_rows,
--          array_agg(id order by created_at) as job_ids,
--          array_agg(started_at order by created_at) as started
--     from public.he_jobs
--    where stage in ('template', 'base_analyze')
--      and status in ('pending', 'running')
--      and payload->>'base_id' is not null
--    group by stage, payload->>'base_id'
--   having count(*) > 1;
--
-- Пусто — миграция пройдёт. Не пусто — она ОСТАНОВИТСЯ сама (диагностика ниже)
-- и ничего не изменит: живую джобу она не удаляет и не отменяет, выбирать между
-- строками за человека не вправе. Разбор руками, по одной базе: лишняя строка с
-- `attempts = 0 and started_at is null` не сделала ничего, её можно снять,
-- оставив самую раннюю:
--
--   update public.he_jobs
--      set status = 'cancelled', finished_at = now(), updated_at = now()
--    where id = '<id лишней строки>';
--
-- Если у обеих проставлен started_at, обе уже платят: дождаться, пока воркер их
-- закончит (уйдут в done/failed и выпадут из предиката), и повторить деплой.
--
-- ПРАВА. Новых таблиц и функций миграция не заводит — только индексы, а у
-- индекса своих прав нет, он живёт правами he_jobs (заперта от
-- anon/authenticated в 20260920_0001_he_rls_lockdown.sql). Поимённый revoke
-- (правило app/src/lib/migrationLint.ts для новых объектов движков) здесь
-- применять не к чему, allowlist'ы прав не меняются.
--
-- Миграция идёт в транзакции (маркера `migrate:no-transaction` нет), как
-- 20260929_0002: долларовые кавычки do-блока сканер нетранзакционного режима не
-- разбирает, а `concurrently` не нужен — he_jobs это очередь стадий, короткий
-- lock незаметен. Повторный прогон безопасен: `if not exists` + диагностика без
-- записи.

-- Блокировка на запись до диагностики: иначе между проверкой и построением
-- индекса успела бы вставиться новая пара, и деплой упал бы сообщением
-- Postgres вместо нашего. Чтения не задеваются.
lock table public.he_jobs in share row exclusive mode;

do $$
declare
  affected_bases bigint;
  extra_jobs bigint;
begin
  -- sum() над bigint возвращает numeric — приводим явно, число обязано быть точным.
  select count(*), coalesce(sum(cnt), 0)::bigint - count(*)
    into affected_bases, extra_jobs
    from (
      select stage, payload->>'base_id' as base_id, count(*) as cnt
        from public.he_jobs
       where stage in ('template', 'base_analyze')
         and status in ('pending', 'running')
         and payload->>'base_id' is not null
       group by stage, payload->>'base_id'
      having count(*) > 1
    ) as dup;

  if affected_bases > 0 then
    raise exception
      'Cannot install the one-active-job-per-base indexes on he_jobs: % (stage, base) pair(s) already have more than one active template or base_analyze job (% extra row(s))',
      affected_bases, extra_jobs
      using hint =
        'Nothing was changed. List them with: select stage, payload->>''base_id'' as base_id, count(*), array_agg(id order by created_at), array_agg(started_at order by created_at) from public.he_jobs where stage in (''template'', ''base_analyze'') and status in (''pending'', ''running'') and payload->>''base_id'' is not null group by 1, 2 having count(*) > 1; keep the earliest row per base and cancel an extra row only while attempts = 0 and started_at is null. If two rows already started, let the worker finish them and re-run the deploy.';
  end if;
end $$;

create unique index if not exists he_jobs_one_active_template_per_base
  on public.he_jobs ((payload->>'base_id'))
  where stage = 'template' and status in ('pending', 'running');

comment on index public.he_jobs_one_active_template_per_base is
  'Одна активная (pending/running) джоба template на базу: закрывает гонку двух постановок генерации шаблона (двойной платный прогон). 23505 в местах вставки = «уже стоит».';

create unique index if not exists he_jobs_one_active_base_analyze_per_base
  on public.he_jobs ((payload->>'base_id'))
  where stage = 'base_analyze' and status in ('pending', 'running');

comment on index public.he_jobs_one_active_base_analyze_per_base is
  'Одна активная (pending/running) джоба base_analyze на базу: закрывает гонку двух постановок анализа (двойной платный прогон). 23505 в местах вставки = «уже стоит».';
