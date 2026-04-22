-- Инициализация main-postgres для Portal.
-- Выполняется один раз при первом запуске supabase/postgres (initdb).
-- Часть ролей/схем в некоторых вариантах образа может отсутствовать на этапе init,
-- поэтому ниже создаём минимум вручную.
--
-- Цель: подготовить БД `postgres` (стандартное имя у Supabase Cloud) для приёма
-- дампа из старого Supabase. Имя БД одинаковое — ничего в коде Portal менять не нужно.

-- Дополнительные расширения, нужные приложению Portal
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'postgres') then
    create role postgres with login superuser createdb createrole replication bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists extensions;
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
