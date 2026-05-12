-- Hotfix for the May-2026 incident "Не удалось загрузить тред" on /client/support.
--
-- Background: on our self-hosted Supabase the migration runner connects as
-- role `postgres`, but the schema-wide default privileges in `public` were
-- only configured for objects created by `supabase_admin`. As a result the
-- two tables created by 20260509_0001_create_client_support_chat.sql landed
-- in the database without any GRANTs for `service_role`/`authenticated`,
-- and our service-role-backed API (`supabaseAdmin`) got
-- `permission denied for table client_support_threads`
-- on every /api/client/support/thread request (verified in
-- public.application_logs on 144.31.54.166 main-postgres). RLS policies
-- exist on these tables but RLS is checked *after* the table-level GRANT
-- — without GRANT even service_role cannot read them.
--
-- 20260509_0003_public_default_privileges_for_postgres.sql plugs this hole
-- structurally for ALL future tables. This file is the surgical fix for
-- the two tables that already exist.

GRANT ALL ON public.client_support_threads  TO service_role;
GRANT ALL ON public.client_support_threads  TO postgres;
GRANT SELECT, INSERT, UPDATE ON public.client_support_threads TO authenticated;

GRANT ALL ON public.client_support_messages TO service_role;
GRANT ALL ON public.client_support_messages TO postgres;
GRANT SELECT, INSERT ON public.client_support_messages TO authenticated;
