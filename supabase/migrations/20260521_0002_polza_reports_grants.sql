-- Companion to 20260521_0001_create_polza_reports_tables.sql.
--
-- Without these GRANTs the service-role-backed API (`supabaseAdmin`) gets
-- `permission denied for table polza_*` on every request, because on our
-- self-hosted Supabase the migration runner connects as `postgres` and the
-- schema-wide default privileges in `public` were only configured for objects
-- created by `supabase_admin`. RLS policies exist on these tables but RLS is
-- checked *after* the table-level GRANT — without GRANT even service_role
-- cannot read them. See 20260509_0002_client_support_grants.sql for the same
-- pattern applied to client-support tables.

GRANT ALL ON public.polza_coldy_credentials TO service_role;
GRANT ALL ON public.polza_coldy_credentials TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.polza_coldy_credentials TO authenticated;

GRANT ALL ON public.polza_report_jobs TO service_role;
GRANT ALL ON public.polza_report_jobs TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.polza_report_jobs TO authenticated;
