-- TG parser jobs should be visible to all authenticated users.
-- Management actions (insert/delete/update) remain governed by existing policies.

drop policy if exists tg_parser_jobs_select_own on public.tg_parser_jobs;
drop policy if exists tg_parser_jobs_select_all on public.tg_parser_jobs;

create policy tg_parser_jobs_select_all
  on public.tg_parser_jobs for select to authenticated
  using (true);
