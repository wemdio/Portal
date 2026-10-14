-- migrate:no-transaction
--
-- ENG («Движок вертикалей», he_*): частичный индекс журнала расхода ENG по
-- времени — под суточную сумму общего потолка ENG
-- (public.he_us_provider_spend_sum, соседняя миграция
-- 20261015_0011_he_us_spend_sum_24h.sql; код —
-- app/src/lib/hypothesisEngine/engClientSpend.ts, HE_US_ENG_DAY_SPEND_CAP_USD).
--
-- ЗАЧЕМ. Сумма идёт у каждого платного нажатия кабинета ENG и у каждой
-- платной постановки воркера, пока порог задан. Отбор — source =
-- 'he_provider_usage' за последние 24 часа. Без этого индекса у
-- application_logs есть только idx_application_logs_source (все строки
-- he_provider_usage за всё время) и idx_application_logs_created_at (сутки
-- ВСЕХ источников, включая fail-closed журнал VE2), и планировщику остаётся
-- сводить их. Таблица растёт без ретенции, и однажды сумма перестала бы
-- укладываться в срок кода (5 с) — тогда потолок молча пускал бы всё
-- (fail-open). Частичный индекс держит ровно строки журнала ENG.
--
-- Вне транзакции и concurrently: в application_logs пишут все процессы
-- портала и воркеров; обычный create index держал бы их вставки всю сборку.
-- drop перед созданием — уборка невалидного индекса упавшей сборки (шапка
-- isNoTransactionMigration в app/scripts/db/ensureDatabase.js), на первом
-- прогоне ничего не делает.
--
-- ПОРЯДОК ВЫКАТА — ЛЮБОЙ: индекс невидим коду, старый код его не замечает,
-- новый работает и без него (медленнее). RU и VE2 не затрагиваются: их
-- запросы этот частичный индекс не выбирают.
--
-- Откат: drop index concurrently if exists public.idx_application_logs_he_usage_created
drop index concurrently if exists public.idx_application_logs_he_usage_created;

create index concurrently if not exists idx_application_logs_he_usage_created
  on public.application_logs (created_at)
  where source = 'he_provider_usage';
