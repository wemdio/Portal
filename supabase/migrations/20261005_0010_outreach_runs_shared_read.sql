-- Запуски автоаутрича (русского и английского) видны всем сотрудникам на
-- чтение: тексты писем смотрят не только авторы запусков (просьба Алины,
-- 05.10.2026). Менять, останавливать и удалять по-прежнему может только
-- автор — политики *_own остаются как были, эти добавляют лишь select.

drop policy if exists parser_jobs_select_outreach_shared on public.parser_jobs;
create policy parser_jobs_select_outreach_shared
  on public.parser_jobs
  for select
  to authenticated
  using (parser_type in ('polza_ru_outreach', 'polza_outreach'));

drop policy if exists polza_ru_outreach_companies_select_shared on public.polza_ru_outreach_companies;
create policy polza_ru_outreach_companies_select_shared
  on public.polza_ru_outreach_companies
  for select
  to authenticated
  using (true);

drop policy if exists polza_outreach_companies_select_shared on public.polza_outreach_companies;
create policy polza_outreach_companies_select_shared
  on public.polza_outreach_companies
  for select
  to authenticated
  using (true);

drop policy if exists polza_chain_templates_select_shared on public.polza_chain_templates;
create policy polza_chain_templates_select_shared
  on public.polza_chain_templates
  for select
  to authenticated
  using (true);
