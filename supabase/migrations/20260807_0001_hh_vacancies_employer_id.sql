-- hh_vacancies: явная колонка employer_id (ID компании на hh.ru).
--
-- До этого ID работодателя был зашит только внутри company_url
-- (https://hh.ru/employer/{id}) и доставался регекспом на стороне кода.
-- Парсеры (hhRunner, hhArchiveSink) получают employer.id бесплатно в
-- search-ответе API — теперь сохраняем его отдельной колонкой.
--
-- Миграция чисто аддитивная: nullable-колонка без default добавляется
-- мгновенно (без перезаписи строк). Все читатели таблицы используют явные
-- списки колонок (exportCsv, pipelineExport, localSearch, baseCollect),
-- поэтому существующие выгрузки не меняются.
--
-- Backfill существующих строк намеренно НЕ здесь: таблица растёт на
-- ~10-30К строк/день, массовый UPDATE в транзакционной миграции держал бы
-- lock. Батчевый backfill — supabase/operator-sql/20260807_hh_vacancies_employer_id_backfill.sql.

alter table public.hh_vacancies
  add column if not exists employer_id text;

comment on column public.hh_vacancies.employer_id is
  'ID работодателя на hh.ru (employer.id из API). Совпадает с числом в company_url (/employer/{id}).';
