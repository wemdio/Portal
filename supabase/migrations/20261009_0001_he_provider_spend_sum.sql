-- ENG («Движок вертикалей», he_*): сумма журнала расхода проекта НА СЕРВЕРЕ.
--
-- ЗАЧЕМ. Потолок расхода us-проекта (app/src/lib/hypothesisEngine/spendCeiling.ts;
-- ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН) сравнивает с порогом известный расход проекта по
-- журналу 'he_provider_usage' (costTelemetry.ts: одна строка application_logs
-- на каждое обращение к Requesty и на каждый поиск Serper, request_id = id
-- проекта). До этой миграции сумма собиралась в Node постраничным чтением
-- строк: старые раньше, не больше 20 страниц по 1 000 строк, дальше — пометка
-- «прочитано не всё». У долгого проекта (больше 20 000 обращений за жизнь)
-- непрочитанный хвост мог бы превысить порог, поэтому при неполном чтении ниже
-- порога потолок отвечал «неизвестно» и пускал (fail-open) — то есть потолок
-- ПРОЕКТА у долгих проектов не срабатывал никогда. Эта функция считает всё
-- одним запросом, без потолка строк.
--
-- ЧТО ВОЗВРАЩАЕТ (одна строка всегда; правила разбора те же, что у
-- costReport.parseHeCostCall / aggregateHeCalls / heUnpricedCalls в Node):
--   priced_usd             — сумма cost_usd обращений к Requesty с известной
--                            ценой (price_known = true И cost_usd — неотрицательное
--                            число); нижняя граница расхода;
--   serper_credits         — сумма кредитов поисков Serper (credits — неотрицательное
--                            число); в доллары переводит вызывающий по тарифу
--                            HE_US_SERPER_USD_PER_1000 — в коде и в БД тарифа нет;
--   requesty_unpriced      — обращения к Requesty без известной цены;
--   serper_calls           — поиски Serper (без тарифа все они «без цены»);
--   serper_credits_unknown — поиски, по которым провайдер не вернул число кредитов
--                            (при заданном тарифе — «без цены» только они);
--   lost_rows              — сумма маркеров пробела lost_before (строки журнала,
--                            которые не легли);
--   calls                  — строки, которые удалось разобрать;
--   skipped_rows           — строки, которые разобрать нельзя (другая версия
--                            формы, чужой рынок или проект, испорченная форма) —
--                            в суммы не входят.
-- Окно — необязательное: p_from включительно, p_to исключительно. Без окна —
-- весь журнал проекта (потолок проекта); с окном «последние 24 часа» — потолок
-- суток (скользящее окно, не календарные UTC-сутки).
--
-- ПРАВА. security invoker (по умолчанию): вызывает только воркер, крон и роуты
-- Next под service_role, который читает application_logs и так (RLS он
-- обходит). Definer не нужен — функция ничего не открывает сверх того, что у
-- вызывающего уже есть. anon/authenticated отзываются ПОИМЁННО (линт
-- app/tests/migrations/grants.test.ts): ALTER DEFAULT PRIVILEGES раздаёт им
-- EXECUTE на каждую новую функцию раннера, а журнал — данные клиентов.
-- set search_path = '' — все имена ниже квалифицированы.
--
-- ИНДЕКС. Новый индекс НЕ создаётся. Отбор идёт по request_id = id проекта, и
-- у application_logs уже есть idx_application_logs_request_id
-- (20260205_0004): запрос читает только строки этого проекта, а не таблицу.
-- Добавить составной индекс здесь было бы небезопасно: миграции раннера идут в
-- begin/commit (app/scripts/db/ensureDatabase.js), и обычный CREATE INDEX на
-- большой application_logs держал бы SHARE-блокировку всё время сборки — а в
-- эту таблицу пишут журнал V2 (fail-closed: несостоявшаяся запись роняет
-- оплаченную стадию) и логгер сервера. CREATE INDEX CONCURRENTLY требует
-- маркера -- migrate:no-transaction, а такая миграция не может держать тело
-- функции (долларовые кавычки) и неидемпотентные create/revoke/grant —
-- значит, если индекс когда-нибудь понадобится, это отдельная миграция.
--
-- ПОРЯДОК ВЫКАТА — ЛЮБОЙ. Код зовёт функцию через rpc и, если её нет (42883 /
-- PGRST202 — миграция не применена), считает как раньше, постраничным чтением
-- с прежним правилом: неполное чтение ниже порога — «неизвестно», пускаем.
-- Потолок по умолчанию выключен, и тогда функцию не зовёт никто.
--
-- Идемпотентна: create or replace, отзыв и выдача прав повторяются без ошибок.

create or replace function public.he_provider_spend_sum(
  p_project_id text,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table(
  priced_usd numeric,
  serper_credits numeric,
  requesty_unpriced bigint,
  serper_calls bigint,
  serper_credits_unknown bigint,
  lost_rows numeric,
  calls bigint,
  skipped_rows bigint
)
language sql
stable
set search_path = ''
as $$
  with journal as (
    select l.context as c
      from public.application_logs l
     where l.request_id = p_project_id
       and l.source = 'he_provider_usage'
       and l.event = 'provider_call'
       and (p_from is null or l.created_at >= p_from)
       and (p_to is null or l.created_at < p_to)
  ),
  checked as (
    select
      -- Разбор строки — как costReport.parseHeCostCall: версия 1, рынок 'us',
      -- project_id = этот проект, непустые job_id и stage, известные provider
      -- и outcome. Сравнения jsonb не бросают на чужой форме, поэтому порядок
      -- их вычисления не важен.
      coalesce(
        pg_catalog.jsonb_typeof(j.c) = 'object'
        and j.c -> 'v' = '1'::jsonb
        and j.c -> 'market' = '"us"'::jsonb
        and j.c -> 'project_id' = pg_catalog.to_jsonb(p_project_id)
        and pg_catalog.jsonb_typeof(j.c -> 'job_id') = 'string'
        and (j.c ->> 'job_id') ~ '\S'
        and pg_catalog.jsonb_typeof(j.c -> 'stage') = 'string'
        and (j.c ->> 'stage') ~ '\S'
        and j.c -> 'provider' in ('"requesty"'::jsonb, '"serper"'::jsonb)
        and j.c -> 'outcome' in ('"ok"'::jsonb, '"failed"'::jsonb, '"aborted"'::jsonb),
        false
      ) as valid,
      j.c ->> 'provider' as provider,
      coalesce(j.c -> 'price_known' = 'true'::jsonb, false) as price_known,
      -- Приведение к numeric — только внутри CASE: порядок вычисления условий
      -- в WHERE/AND Postgres не гарантирует, а CASE — гарантирует.
      case when pg_catalog.jsonb_typeof(j.c -> 'cost_usd') = 'number'
        then (j.c ->> 'cost_usd')::numeric end as cost_usd,
      case when pg_catalog.jsonb_typeof(j.c -> 'credits') = 'number'
        then (j.c ->> 'credits')::numeric end as credits,
      case when pg_catalog.jsonb_typeof(j.c -> 'lost_before') = 'object'
        then j.c -> 'lost_before' end as lost_before
    from journal j
  ),
  lost as (
    select coalesce(pg_catalog.sum(x.n), 0) as lost_total
      from (
        select case when pg_catalog.jsonb_typeof(e.value) = 'number'
                 then (e.value #>> '{}')::numeric end as n
          from checked k
          cross join lateral pg_catalog.jsonb_each(k.lost_before) e
         where k.valid
      ) x
     where x.n >= 0
  )
  select
    coalesce(pg_catalog.sum(k.cost_usd) filter (
      where k.valid and k.provider = 'requesty' and k.price_known and k.cost_usd >= 0
    ), 0) as priced_usd,
    coalesce(pg_catalog.sum(k.credits) filter (
      where k.valid and k.provider = 'serper' and k.credits >= 0
    ), 0) as serper_credits,
    pg_catalog.count(*) filter (
      where k.valid and k.provider = 'requesty'
        and not (k.price_known and coalesce(k.cost_usd >= 0, false))
    ) as requesty_unpriced,
    pg_catalog.count(*) filter (where k.valid and k.provider = 'serper') as serper_calls,
    pg_catalog.count(*) filter (
      where k.valid and k.provider = 'serper' and not coalesce(k.credits >= 0, false)
    ) as serper_credits_unknown,
    (select l.lost_total from lost l) as lost_rows,
    pg_catalog.count(*) filter (where k.valid) as calls,
    pg_catalog.count(*) filter (where not k.valid) as skipped_rows
  from checked k;
$$;

comment on function public.he_provider_spend_sum(text, timestamptz, timestamptz) is
  'ENG: известный расход проекта по журналу he_provider_usage (application_logs, request_id = id проекта) за всё время или за окно [p_from, p_to). Нижняя граница: обращения без цены только считаются, Serper — в кредитах.';

revoke all on function public.he_provider_spend_sum(text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.he_provider_spend_sum(text, timestamptz, timestamptz)
  to service_role, postgres;
