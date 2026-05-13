-- Расширение pg_trgm позволяет использовать GIN-индекс для быстрых ILIKE '%...%' запросов.
-- Без него фильтрация по регионам (address ilike '%токен%') делает full scan таблицы.
create extension if not exists pg_trgm;

-- GIN-индекс на address — ускоряет ILIKE '%...%' в разы при большом количестве регионов.
create index if not exists companies_directory_address_trgm_idx
  on public.companies_directory using gin (address gin_trgm_ops);

-- GIN-индекс на name — ускоряет фильтрацию по legal_forms (name ilike 'ИП %' и т.п.).
create index if not exists companies_directory_name_trgm_idx
  on public.companies_directory using gin (name gin_trgm_ops);
