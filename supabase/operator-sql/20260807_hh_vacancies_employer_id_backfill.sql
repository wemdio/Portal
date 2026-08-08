-- Backfill hh_vacancies.employer_id из company_url для уже собранных строк.
--
-- Запускать ВРУЧНУЮ после применения миграции
-- supabase/migrations/20260807_0001_hh_vacancies_employer_id.sql.
--
-- Вынесено из транзакционной миграции: hh_vacancies большая (поток
-- ~10-30К строк/день), один UPDATE на всю таблицу держал бы lock и
-- раздувал WAL. Здесь — батчи по 50К строк.
--
-- Запускать ПОВТОРНО, пока affected rows не станет 0. Скрипт идемпотентен:
-- трогает только строки с employer_id IS NULL и валидным /employer/{id}
-- в company_url.

update public.hh_vacancies
set employer_id = substring(company_url from '/employer/(\d+)')
where id in (
  select id
  from public.hh_vacancies
  where employer_id is null
    and company_url ~ '/employer/\d+'
  limit 50000
);
