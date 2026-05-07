-- Fix: "permission denied for table companies_directory" на проде.
--
-- Причина та же, что и для email_sequence_v2 (см. 20260505_0001):
-- на self-hosted Supabase для схемы public НЕ настроен
-- ALTER DEFAULT PRIVILEGES ... GRANT ... TO service_role, authenticated, anon.
-- Без этого PostgreSQL режет доступ ДО проверки RLS-policies.
--
-- API-роуты companies-search и activity-types работают через supabaseAdmin
-- (service_role), но PostgREST всё равно требует явный GRANT для роли.
--
-- Идемпотентно: повторный GRANT — no-op.

grant select, insert, update, delete on public.companies_directory to service_role;
grant select on public.companies_directory to authenticated;
