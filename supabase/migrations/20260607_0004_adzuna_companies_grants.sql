-- GRANT companion for 20260607_0002_create_adzuna_parser_table.sql.
--
-- public.adzuna_companies mirrors public.ats_companies' ownership model: RLS is
-- enabled with per-job policies (auth.uid() = parser_jobs.user_id), so
-- authenticated users need table-level CRUD (the policies decide WHICH rows),
-- and service_role (workers writing results) needs full access. Same grants the
-- ats_companies migration applies inline.
--
-- Added as a companion rather than by editing the create migration (which may
-- already be applied); the repo's grants-guard scans the whole migrations tree.
grant all on public.adzuna_companies to service_role;
grant select, insert, update, delete on public.adzuna_companies to authenticated;
