-- ENG («Движок вертикалей», he_*): известный расход ВСЕГО рынка us за окно —
-- сумма журнала he_provider_usage по всем us-проектам всех клиентов, на сервере.
--
-- ЗАЧЕМ. Общий суточный потолок ENG (app/src/lib/hypothesisEngine/engClientSpend.ts,
-- HE_US_ENG_DAY_SPEND_CAP_USD; ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН — тогда функцию не зовёт
-- никто). Потолки проекта и клиента считают каждый проект или каждого клиента
-- отдельно, и поток новых аккаунтов обходит их в столько раз, сколько аккаунтов:
-- ENG и RU (VE2, staff-инструмент V1) платят с одного ключа Requesty и одного
-- аккаунта Serper, пока не заданы HE_US_REQUESTY_API_KEY / HE_US_SERPER_API_KEY.
-- Этот порог смотрит на рынок целиком: расход us за скользящие последние
-- 24 часа достиг порога — ни одна платная постановка ENG не идёт (RU и VE2
-- не трогаются: в журнале только строки us-проектов, а проверку зовут только
-- ENG-пути).
--
-- ЧТО ВОЗВРАЩАЕТ (одна строка всегда) — те же колонки и те же правила разбора
-- строки, что he_provider_spend_sum (20261009_0001) и he_client_provider_spend_sum
-- (20261010_0001): priced_usd, serper_credits, requesty_unpriced, serper_calls,
-- serper_credits_unknown, lost_rows, calls, skipped_rows и projects — сколько
-- разных проектов дали хоть одну разобранную строку. Отличие одно: project_id
-- в context сверяется с request_id этой же строки, а не с аргументом.
-- Удалённые проекты в сумме остаются: строки журнала живут без he_projects, а
-- потраченные за сутки деньги потрачены.
--
-- ОКНО: p_from включительно, p_to исключительно. p_from = NULL — последние
-- 24 часа до now() (без нижней границы функция читала бы весь журнал, а это
-- уже не дешёвая проверка у каждой платной постановки). p_to = NULL — без
-- верхней границы.
--
-- СТОИМОСТЬ И ИНДЕКС. Отбор — по created_at за окно и source. Под него —
-- частичный индекс (created_at) where source = 'he_provider_usage' из
-- соседней миграции 20261015_0012_he_provider_usage_created_idx.sql: здесь
-- его создать нельзя — миграции раннера идут в транзакции, обычный CREATE
-- INDEX держал бы SHARE-блокировку большой application_logs всю сборку (а
-- туда пишет fail-closed журнал VE2), а CREATE INDEX CONCURRENTLY требует
-- миграции вне транзакции, которая не может держать тело функции. Без того
-- индекса (порядок выката любой) планировщик сводит
-- idx_application_logs_source (вся история he_provider_usage) и
-- idx_application_logs_created_at (сутки всех источников) — корректно, но
-- медленнее; срок чтения у кода — 5 с (engClientSpend.ts,
-- HE_ENG_DAY_SPEND_CHECK_TIMEOUT_MS), дальше «неизвестно» и алерт команде.
--
-- ПРАВА. security invoker: вызывают только воркер, крон и роуты Next под
-- service_role, который читает application_logs и так. anon/authenticated
-- отзываются поимённо (линт app/tests/migrations/grants.test.ts).
-- set search_path = '' — все имена квалифицированы.
--
-- ПОРЯДОК ВЫКАТА — ЛЮБОЙ. Миграция только добавляет функцию: старый код её не
-- зовёт. Новый код без неё (42883 / PGRST202) считает общий расход
-- «неизвестным» и пускает (fail-open), строкой в лог; порог по умолчанию
-- выключен, и тогда функцию не зовёт никто.
--
-- Идемпотентна: create or replace, отзыв и выдача прав повторяются без ошибок.

create or replace function public.he_us_provider_spend_sum(
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
  skipped_rows bigint,
  projects bigint
)
language sql
stable
set search_path = ''
as $$
  with journal as (
    select l.context as c, l.request_id as r
      from public.application_logs l
     where l.source = 'he_provider_usage'
       and l.event = 'provider_call'
       and l.created_at >= coalesce(p_from, pg_catalog.now() - interval '24 hours')
       and (p_to is null or l.created_at < p_to)
  ),
  checked as (
    select
      -- Разбор строки — как у he_provider_spend_sum (costReport.parseHeCostCall):
      -- версия 1, рынок 'us', project_id = request_id строки, непустые job_id и
      -- stage, известные provider и outcome.
      coalesce(
        pg_catalog.jsonb_typeof(j.c) = 'object'
        and j.r is not null
        and j.c -> 'v' = '1'::jsonb
        and j.c -> 'market' = '"us"'::jsonb
        and j.c -> 'project_id' = pg_catalog.to_jsonb(j.r)
        and pg_catalog.jsonb_typeof(j.c -> 'job_id') = 'string'
        and (j.c ->> 'job_id') ~ '\S'
        and pg_catalog.jsonb_typeof(j.c -> 'stage') = 'string'
        and (j.c ->> 'stage') ~ '\S'
        and j.c -> 'provider' in ('"requesty"'::jsonb, '"serper"'::jsonb)
        and j.c -> 'outcome' in ('"ok"'::jsonb, '"failed"'::jsonb, '"aborted"'::jsonb),
        false
      ) as valid,
      j.r as project_id,
      j.c ->> 'provider' as provider,
      coalesce(j.c -> 'price_known' = 'true'::jsonb, false) as price_known,
      -- Приведение к numeric — только внутри CASE (порядок условий в AND
      -- Postgres не гарантирует, а CASE — гарантирует).
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
    pg_catalog.count(*) filter (where not k.valid) as skipped_rows,
    pg_catalog.count(distinct k.project_id) filter (where k.valid) as projects
  from checked k;
$$;

comment on function public.he_us_provider_spend_sum(timestamptz, timestamptz) is
  'ENG: известный расход всего рынка us по журналу he_provider_usage (application_logs) за окно [p_from, p_to); p_from NULL — последние 24 часа. Нижняя граница, правила разбора — как у he_provider_spend_sum. Читает общий суточный потолок ENG (HE_US_ENG_DAY_SPEND_CAP_USD).';

revoke all on function public.he_us_provider_spend_sum(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.he_us_provider_spend_sum(timestamptz, timestamptz)
  to service_role, postgres;
