-- ────────────────────────────────────────────────────────────────────────────
-- Служебные роли и права после pg_restore дампа main-supabase.
--
-- Зачем: дамп сделан с --no-owner --no-privileges (так его пишет portal-backup),
-- а свежий supabase/postgres:15.8.1.060 на пустом volume НЕ создаёт роли
-- authenticator / supabase_auth_admin / supabase_storage_admin / postgres —
-- на 144 их создавали руками при апрельской (2026) миграции из облака Supabase.
-- Без этого auth/rest/storage падают в рестарт-цикл ("role does not exist" /
-- "password authentication failed") — грабли репетиции 18.07.2026.
--
-- Применение (пароль передаётся снаружи, см. finish.sh):
--   psql -U supabase_admin -d postgres -v pgpass='<MAIN_PG_PASSWORD>' -f fix-roles.sql
-- Скрипт идемпотентен — можно гонять повторно.
-- ────────────────────────────────────────────────────────────────────────────

-- 1) Роли (создать недостающие)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin LOGIN CREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
    CREATE ROLE supabase_storage_admin LOGIN CREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres LOGIN CREATEROLE CREATEDB BYPASSRLS;
  END IF;
END $$;

GRANT anon, authenticated, service_role TO authenticator;
GRANT anon, authenticated, service_role TO postgres;
-- storage-api на каждый запрос делает set_config('role', <роль из JWT>) со
-- своего подключения supabase_storage_admin — без членства в API-ролях это
-- 42501, который storage маскирует под "new row violates row-level security
-- policy" (грабли репетиции 18.07.2026).
GRANT anon, authenticated, service_role TO supabase_storage_admin;

-- BYPASSRLS выставляем безусловно: если роль service_role уже существовала
-- (создана образом при initdb) — она могла быть БЕЗ права обхода RLS, и
-- IF NOT EXISTS выше её не тронул. Симптом: storage API отдаёт 403
-- "new row violates row-level security policy" на service key
-- (грабли репетиции 18.07.2026).
ALTER ROLE service_role BYPASSRLS;

-- 2) Пароли (dollar-независимая передача через psql-переменную)
ALTER USER authenticator          WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin    WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
ALTER USER postgres               WITH PASSWORD :'pgpass';

-- 3) Владельцы служебных схем: после --no-owner всё принадлежит supabase_admin,
-- а gotrue/storage-api работают из-под своих ролей и должны владеть своими
-- таблицами (иначе их миграторы и сервис падают на правах).
ALTER SCHEMA auth OWNER TO supabase_auth_admin;
ALTER SCHEMA storage OWNER TO supabase_storage_admin;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT format('ALTER TABLE auth.%I OWNER TO supabase_auth_admin', tablename) AS q
           FROM pg_tables WHERE schemaname = 'auth' LOOP
    EXECUTE r.q;
  END LOOP;
  FOR r IN SELECT format('ALTER SEQUENCE auth.%I OWNER TO supabase_auth_admin', sequencename) AS q
           FROM pg_sequences WHERE schemaname = 'auth' LOOP
    EXECUTE r.q;
  END LOOP;
  FOR r IN SELECT format('ALTER TABLE storage.%I OWNER TO supabase_storage_admin', tablename) AS q
           FROM pg_tables WHERE schemaname = 'storage' LOOP
    EXECUTE r.q;
  END LOOP;
  FOR r IN SELECT format('ALTER SEQUENCE storage.%I OWNER TO supabase_storage_admin', sequencename) AS q
           FROM pg_sequences WHERE schemaname = 'storage' LOOP
    EXECUTE r.q;
  END LOOP;
END $$;

-- 4) Доступы API-ролей (дамп --no-privileges снёс все GRANT; RLS-политики
-- при этом в дампе ЕСТЬ — они и решают, кому что можно; GRANT — нижний слой).
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon, authenticated, service_role;

-- PostgREST обслуживает public,storage,graphql_public; graphql_public исключена
-- из дампа — создать пустую, чтобы PostgREST не падал на schema cache.
CREATE SCHEMA IF NOT EXISTS graphql_public;
GRANT USAGE ON SCHEMA graphql_public TO postgres, anon, authenticated, service_role;

-- 5) GoTrue: рабочая схема его учётки — auth. Без role-level search_path его
-- мигратор лезет создавать schema_migrations в public → "permission denied for
-- schema public", рестарт-цикл (грабли репетиции 18.07.2026; на 144 настройку
-- выставили руками в апреле).
ALTER ROLE supabase_auth_admin SET search_path = auth;

-- 6) Realtime: строит свои таблицы в схеме _realtime сам, но сама схема должна
-- существовать (исключена из дампа осознанно — сервис пересоздаёт содержимое
-- и tenant из env при SEED_SELF_HOST=true). Без неё Ecto падает с
-- "no schema has been selected to create in" (те же грабли).
CREATE SCHEMA IF NOT EXISTS _realtime;
ALTER SCHEMA _realtime OWNER TO supabase_admin;
