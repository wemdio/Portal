-- Инициализация main-postgres для Portal.
-- Выполняется один раз при первом запуске supabase/postgres (initdb).
-- Базовые роли (anon, authenticated, service_role, supabase_*) и схемы (auth, storage,
-- realtime, extensions, _realtime) уже созданы образом supabase/postgres.
--
-- Цель: подготовить БД `postgres` (стандартное имя у Supabase Cloud) для приёма
-- дампа из старого Supabase. Имя БД одинаковое — ничего в коде Portal менять не нужно.

-- Дополнительные расширения, нужные приложению Portal
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";
create extension if not exists vector with schema extensions;
create extension if not exists pg_cron;

-- Грантим service_role полные права на public — этим клиентом ходит supabaseAdmin.
grant all privileges on schema public to service_role;
grant all privileges on schema public to authenticated;
grant usage on schema public to anon;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant usage, select on sequences to authenticated;
alter default privileges in schema public grant select on tables to anon;
