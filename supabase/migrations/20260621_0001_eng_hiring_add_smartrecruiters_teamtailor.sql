-- SmartRecruiters (#9) and Teamtailor (#10) were added to the ENG hiring parser
-- in code/UI but the source CHECK constraints still only allowed the original 8,
-- so cache-run / cache / result inserts for the new sources failed with
-- "new row ... violates check constraint" (job errored ~44% in, at smartrecruiters).
-- Extend all three constraints to the full 10-source list.

alter table if exists public.eng_hiring_cache
  drop constraint if exists eng_hiring_cache_source_check;

alter table if exists public.eng_hiring_cache
  add constraint eng_hiring_cache_source_check
  check (source in ('greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee', 'breezy', 'workday', 'smartrecruiters', 'teamtailor'));

alter table if exists public.eng_hiring_cache_runs
  drop constraint if exists eng_hiring_cache_runs_source_check;

alter table if exists public.eng_hiring_cache_runs
  add constraint eng_hiring_cache_runs_source_check
  check (source in ('greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee', 'breezy', 'workday', 'smartrecruiters', 'teamtailor'));

alter table if exists public.eng_hiring_vacancies
  drop constraint if exists eng_hiring_vacancies_source_check;

alter table if exists public.eng_hiring_vacancies
  add constraint eng_hiring_vacancies_source_check
  check (source in ('greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee', 'breezy', 'workday', 'smartrecruiters', 'teamtailor'));
