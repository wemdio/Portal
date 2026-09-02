-- Единый жизненный цикл фоновых задач (spec: docs/superpowers/specs/2026-09-02-job-lifecycle-design.md).
--
-- Пять одинаковых колонок в каждой таблице задач. Ни одна существующая колонка
-- и ни один статус не меняются: экраны и монитор здоровья работают как раньше.
--
--   lease_until  — до какого момента задача арендована исполнителем; истекла или
--                  null при status=running → задачу можно перехватить.
--   run_token    — жетон владения, выписывается при каждом захвате; все записи
--                  исполнителя в строку ограничены «and run_token = свой».
--   worker_id    — имя исполнителя для диагностики.
--   checkpoint   — сохранённый прогресс, структура своя у каждого воркера.
--   attempts     — число падений/потерь аренды; после трёх задача уходит в ошибку.
--
-- Только add column if not exists: миграция идемпотентна, у base_constructor_jobs
-- run_token уже есть (20260901_0002), у he_jobs/ve_jobs уже есть attempts.
--
-- Индекс (status, lease_until) сюда не входит — он живёт в companion-миграции
-- 20260902_0002 как create index concurrently вне транзакции: обычный create
-- index внутри этой транзакции держит SHARE-лок на всё время сборки и блокирует
-- запись в горячие таблицы очередей (тот же прецедент, что и idx_amo_leads_inn
-- на amo_leads, 20260813_0002).

do $$
declare
  t text;
  tables text[] := array[
    'base_constructor_jobs',
    'tg_parser_jobs',
    'parser_jobs',
    'hh_archive_jobs',
    'yandex_direct_jobs',
    'search_parser_jobs',
    'sales_chat_archive_jobs',
    'sales_chat_sync_runs',
    'yandex_maps_jobs',
    'yandex_maps_catalog_discovery_queue',
    'tg_outreach_campaigns',
    'tg_outreach_warmup_runs',
    'tg_outreach_jobs',
    'ai_campaigns',
    'ai_caller_jobs',
    'li_campaigns',
    'website_enrichment_jobs',
    'brief_scoring_jobs',
    'crypto_payment_jobs',
    'email_validation_jobs',
    'inn_enrich_jobs',
    'website_inn_lookup_jobs',
    'tg_scan_jobs',
    'tg_transcribe_jobs',
    'client_report_export_jobs',
    'he_jobs',
    've_jobs',
    'client_manual_score_runs'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I add column if not exists lease_until timestamptz', t);
    execute format('alter table public.%I add column if not exists run_token uuid', t);
    execute format('alter table public.%I add column if not exists worker_id text', t);
    execute format('alter table public.%I add column if not exists checkpoint jsonb', t);
    execute format('alter table public.%I add column if not exists attempts int not null default 0', t);
    execute format(
      'comment on column public.%I.lease_until is %L',
      t, 'Аренда исполнителя. Истекла или null при running — задачу можно перехватить (lib/jobs/lifecycle.ts).'
    );
    execute format(
      'comment on column public.%I.run_token is %L',
      t, 'Жетон владения текущей арендой; записи исполнителя ограничены and run_token = свой (lib/jobs/lifecycle.ts).'
    );
    execute format(
      'comment on column public.%I.worker_id is %L',
      t, 'Имя исполнителя, захватившего задачу — для диагностики (lib/jobs/lifecycle.ts).'
    );
    execute format(
      'comment on column public.%I.checkpoint is %L',
      t, 'Сохранённый прогресс задачи, структура своя у каждого воркера (lib/jobs/lifecycle.ts).'
    );
    execute format(
      'comment on column public.%I.attempts is %L',
      t, 'Число падений/потерь аренды; после трёх задача уходит в ошибку (lib/jobs/lifecycle.ts).'
    );
  end loop;
end $$;

-- Выдать аренду задачам, которые уже висят в работе на момент перехода.
--
-- Зачем: захват «истёкшей» аренды считает lease_until is null свободной
-- строкой. Значит, любая задача, оставленная в работе СТАРЫМ контейнером
-- (у неё аренды нет вовсе), станет добычей первой же новой реплики на первом
-- же опросе. Штатный деплой сперва гасит все 12 реплик конструктора баз, и
-- отбирать не у кого, но одиночный рестарт или частичный recreate оставляет
-- рядом до 11 живых исполнителей. Ограждение жетоном не даст испортить
-- данные, но цена всё равно реальная: резюм с последнего чекпоинта и заново
-- оплаченные AI-вызовы и скрейпинг.
--
-- Пять минут — ровно дефолтная аренда пилотов: живой исполнитель успеет
-- продлить её на ближайшем тике продления (аренда/3), а брошенная строка
-- истечёт сама и будет подобрана штатно.
--
-- Только две пилотные таблицы: остальные воркеры ещё не на библиотеке, и
-- аренда им сейчас ничего не значит. Каждая следующая фаза прайминг своих
-- таблиц делает своей миграцией, когда её воркер переезжает.
--
-- Идемпотентно: only where lease_until is null — повторный прогон миграции
-- не сдвигает аренду, которую уже держит живой исполнитель.
update public.base_constructor_jobs
   set lease_until = now() + interval '5 minutes'
 where status = 'processing'
   and lease_until is null;

update public.tg_parser_jobs
   set lease_until = now() + interval '5 minutes'
 where status = 'running'
   and lease_until is null;
