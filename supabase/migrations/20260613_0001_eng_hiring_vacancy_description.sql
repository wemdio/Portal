alter table if exists public.eng_hiring_cache
  add column if not exists vacancy_description text;

alter table if exists public.eng_hiring_vacancies
  add column if not exists vacancy_description text;
