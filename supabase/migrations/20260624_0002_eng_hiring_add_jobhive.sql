-- Add the bulk source 'jobhive' to the ENG hiring parser. jobhive is the daily
-- stapply.ai feed (MIT) of ~4.3M postings across 47 ATS platforms — including the
-- enterprise ATS we cannot fetch ourselves. It is ingested out-of-band by
-- worker/jobhiveIngestCron into eng_hiring_cache and consumed by the normal run as a
-- cache-only source (CACHE_ONLY_SOURCES). As with smartrecruiters/teamtailor before,
-- every insert path checks the source CHECK constraint, so extend all three to the
-- full 11-source list before the ingest can write a single row.

alter table if exists public.eng_hiring_cache
  drop constraint if exists eng_hiring_cache_source_check;

alter table if exists public.eng_hiring_cache
  add constraint eng_hiring_cache_source_check
  check (source in ('greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee', 'breezy', 'workday', 'smartrecruiters', 'teamtailor', 'jobhive'));

alter table if exists public.eng_hiring_cache_runs
  drop constraint if exists eng_hiring_cache_runs_source_check;

alter table if exists public.eng_hiring_cache_runs
  add constraint eng_hiring_cache_runs_source_check
  check (source in ('greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee', 'breezy', 'workday', 'smartrecruiters', 'teamtailor', 'jobhive'));

alter table if exists public.eng_hiring_vacancies
  drop constraint if exists eng_hiring_vacancies_source_check;

alter table if exists public.eng_hiring_vacancies
  add constraint eng_hiring_vacancies_source_check
  check (source in ('greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee', 'breezy', 'workday', 'smartrecruiters', 'teamtailor', 'jobhive'));
