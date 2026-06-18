alter table if exists public.eng_hiring_cache
  drop constraint if exists eng_hiring_cache_source_check;

alter table if exists public.eng_hiring_cache
  add constraint eng_hiring_cache_source_check
  check (source in ('greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee', 'breezy', 'workday'));

alter table if exists public.eng_hiring_cache_runs
  drop constraint if exists eng_hiring_cache_runs_source_check;

alter table if exists public.eng_hiring_cache_runs
  add constraint eng_hiring_cache_runs_source_check
  check (source in ('greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee', 'breezy', 'workday'));

alter table if exists public.eng_hiring_vacancies
  drop constraint if exists eng_hiring_vacancies_source_check;

alter table if exists public.eng_hiring_vacancies
  add constraint eng_hiring_vacancies_source_check
  check (source in ('greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee', 'breezy', 'workday'));
