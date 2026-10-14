-- ENG / RU «Движок вертикалей» (he_*): не больше ОДНОЙ активной джобы
-- генерации цепочки писем (stage = 'chain') на вертикаль. Активная — status
-- 'pending' или 'running'; 'done', 'failed', 'cancelled' в предикат не входят.
--
-- ЗАЧЕМ. Цепочка — платная стадия (вызовы модели), и это была единственная
-- платная стадия, у активной джобы которой не было уникальности в БД (у
-- site_profile — 20260929_0002, у template и base_analyze — 20261008_0001).
-- Все постановки цепочки дедупят ЧТЕНИЕМ «активная chain-джоба этой вертикали
-- уже есть?» до insert, и два запроса в один момент проходят это чтение ОБА:
--   - двойной клик / два таба на POST api/client/eng/verticals/[id]/chain
--     (кабинет его не зовёт — прямые запросы и старые бандлы) или на «Собрать
--     цепочку» специалиста (POST api/tools/hypothesis-engine/verticals/[id]/chain);
--   - «Start outreach» клиента (autopilotReconcile.ts) одновременно с любым из
--     роутов выше или со вторым таким же проходом (ночной проход и кнопка).
-- Воркер один и берёт джобы по очереди, поэтому обе строки исполнятся, и до
-- этой миграции каждая платила полный прогон цепочки. Partial unique index
-- пропускает первую вставку; проигравшая получает 23505.
--
-- МЕСТА ВСТАВКИ СТАДИИ chain И ИХ ОТВЕТ НА 23505 (других вставок chain в
-- дереве нет: воркер ставит только следующие research-стадии, а возврат джобы
-- в очередь двигает ту же строку):
--   - api/client/eng/verticals/[id]/chain — 200 с уже стоящей джобой (ответ
--     дедупа); стоящей уже нет — 409 «запуск уже закончился, обновите
--     страницу»;
--   - api/tools/hypothesis-engine/verticals/[id]/chain — то же для
--     специалиста;
--   - autopilotReconcile.ts — пропуск вертикали 'chain_running' без паузы
--     (тот же исход, что у дедупа по снапшоту).
--
-- ПОЧЕМУ ВОРКЕР НА ИНДЕКС НЕ НАТКНЁТСЯ ВНЕ ГОНКИ. Каждое место вставки выше
-- сначала читает активные chain-строки вертикали. Возврат строки в очередь
-- (failJob, resetStuckJobs) двигает ТУ ЖЕ строку между 'running' и 'pending' —
-- обе внутри предиката, второй строки не появляется. Строка без vertical_id в
-- payload (такой вставки в дереве нет) в индекс попадает как NULL и с другими
-- не конфликтует.
--
-- ЧТО СДЕЛАТЬ ДО ДЕПЛОЯ — ТОЛЬКО ЧТЕНИЕ, ничего не меняет:
--
--   select payload->>'vertical_id' as vertical_id, count(*) as active_rows,
--          array_agg(id order by created_at) as job_ids,
--          array_agg(started_at order by created_at) as started
--     from public.he_jobs
--    where stage = 'chain'
--      and status in ('pending', 'running')
--      and payload->>'vertical_id' is not null
--    group by payload->>'vertical_id'
--   having count(*) > 1;
--
-- Пусто — миграция пройдёт. Не пусто — она ОСТАНОВИТСЯ сама (диагностика ниже)
-- и ничего не изменит: живую джобу она не удаляет и не отменяет, выбирать между
-- строками за человека не вправе. Разбор руками, по одной вертикали: лишняя
-- строка с `attempts = 0 and started_at is null` не сделала ничего, её можно
-- снять, оставив самую раннюю:
--
--   update public.he_jobs
--      set status = 'cancelled', finished_at = now(), updated_at = now()
--    where id = '<id лишней строки>';
--
-- Если у обеих проставлен started_at, обе уже платят: дождаться, пока воркер их
-- закончит (уйдут в done/failed и выпадут из предиката), и повторить деплой.
--
-- ПРАВА. Новых таблиц и функций миграция не заводит — только индекс, а у
-- индекса своих прав нет, он живёт правами he_jobs (заперта от
-- anon/authenticated в 20260920_0001_he_rls_lockdown.sql). Поимённый revoke
-- (правило app/src/lib/migrationLint.ts для новых объектов движков) здесь
-- применять не к чему, allowlist'ы прав не меняются.
--
-- КОД ДО МИГРАЦИИ. Без индекса 23505 на вставку chain не бывает, и все три
-- места вставки идут прежним путём (дедуп чтением, гонка открыта).
--
-- Миграция идёт в транзакции (маркера `migrate:no-transaction` нет), как
-- 20261008_0001: долларовые кавычки do-блока сканер нетранзакционного режима
-- не разбирает, а `concurrently` не нужен — he_jobs это очередь стадий,
-- короткий lock незаметен. Повторный прогон безопасен: `if not exists` +
-- диагностика без записи.

-- Блокировка на запись до диагностики: иначе между проверкой и построением
-- индекса успела бы вставиться новая пара, и деплой упал бы сообщением
-- Postgres вместо нашего. Чтения не задеваются.
lock table public.he_jobs in share row exclusive mode;

do $$
declare
  affected_verticals bigint;
  extra_jobs bigint;
begin
  -- sum() над bigint возвращает numeric — приводим явно, число обязано быть точным.
  select count(*), coalesce(sum(cnt), 0)::bigint - count(*)
    into affected_verticals, extra_jobs
    from (
      select payload->>'vertical_id' as vertical_id, count(*) as cnt
        from public.he_jobs
       where stage = 'chain'
         and status in ('pending', 'running')
         and payload->>'vertical_id' is not null
       group by payload->>'vertical_id'
      having count(*) > 1
    ) as dup;

  if affected_verticals > 0 then
    raise exception
      'Cannot install the one-active-chain-per-vertical index on he_jobs: % vertical(s) already have more than one active chain job (% extra row(s))',
      affected_verticals, extra_jobs
      using hint =
        'Nothing was changed. List them with: select payload->>''vertical_id'' as vertical_id, count(*), array_agg(id order by created_at), array_agg(started_at order by created_at) from public.he_jobs where stage = ''chain'' and status in (''pending'', ''running'') and payload->>''vertical_id'' is not null group by 1 having count(*) > 1; keep the earliest row per vertical and cancel an extra row only while attempts = 0 and started_at is null. If two rows already started, let the worker finish them and re-run the deploy.';
  end if;
end $$;

create unique index if not exists he_jobs_one_active_chain_per_vertical
  on public.he_jobs ((payload->>'vertical_id'))
  where stage = 'chain' and status in ('pending', 'running');

comment on index public.he_jobs_one_active_chain_per_vertical is
  'Одна активная (pending/running) джоба chain на вертикаль: закрывает гонку двух постановок генерации цепочки писем (двойной платный прогон). 23505 в местах вставки = «уже стоит».';
