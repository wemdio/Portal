\set ON_ERROR_STOP on

-- 2ГИС → VE2, шаг Ш3 (docs/reports/2026-10-26-2gis-ve2-plan.md): свой
-- пользователь VE2 для базы 2ГИС — только чтение и не больше 2 соединений, чтобы
-- VE2 не занимал соединения OutreachOS и парсера (у twogis_runtime их 12 на всех).
--
-- Запускать под postgres в базе 2gis_dataset. Повторный запуск безопасен.
-- Пароль здесь не задаётся и нигде не печатается: его ставят отдельно
-- SCRAM-верификатором с выключенным логированием (README, «Пользователь VE2»).
-- Входить только в 2gis_dataset ему разрешают строки pg_hba.conf main-postgres:
-- без них он вошёл бы и в основную базу postgres (CONNECT там у PUBLIC).
-- Read-only сессия может снять сама — граница доступа здесь гранты, а не она.

DO $guard$
BEGIN
  IF current_database() <> '2gis_dataset' THEN
    RAISE EXCEPTION
      'Refusing VE2 access setup: expected database 2gis_dataset, got %',
      current_database();
  END IF;
END
$guard$;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'twogis_ve2') THEN
    CREATE ROLE twogis_ve2 LOGIN NOINHERIT CONNECTION LIMIT 2;
  END IF;
END
$role$;

ALTER ROLE twogis_ve2 LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 2;

-- Короткие ожидания: страница VE2 — одна read-only транзакция, без параллельных
-- воркеров инстанса (их свободно около 4 на всю основную базу).
ALTER ROLE twogis_ve2 SET default_transaction_read_only = on;
ALTER ROLE twogis_ve2 SET statement_timeout = '10s';
ALTER ROLE twogis_ve2 SET lock_timeout = '1s';
ALTER ROLE twogis_ve2 SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE twogis_ve2 SET max_parallel_workers_per_gather = 0;

GRANT CONNECT ON DATABASE "2gis_dataset" TO twogis_ve2;
GRANT USAGE ON SCHEMA public TO twogis_ve2;
GRANT SELECT ON public.cards, public.card_subcategories, public.dataset_snapshots, public.facet_subcategories
  TO twogis_ve2;
-- Схему ve2 (card_features, build_state) создаёт шаг Ш5 вместе с ролью сборщика,
-- и даёт на неё SELECT этой роли правами по умолчанию.
