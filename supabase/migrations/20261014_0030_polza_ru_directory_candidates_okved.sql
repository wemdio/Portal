-- Общая база компаний для RU автоаутрича: отбор по ОКВЭД ЦА и пул до 50 000
-- (14.10.2026: «просят 1000 готовых — тянем, пока не наберём»; прежняя функция
-- отдавала 5 000 случайных строк без ОКВЭД).
create or replace function public.polza_ru_directory_candidates_v2(
  p_min_revenue bigint,
  p_max_revenue bigint,
  p_min_employees integer,
  p_okved_regex text,
  p_limit integer
)
returns table (
  inn text,
  name text,
  website text,
  email text,
  revenue bigint,
  employees_count integer,
  okved_code text
)
language sql
volatile
set statement_timeout = '120s'
as $$
  select d.inn, d.name, d.website, d.email, d.revenue, d.employees_count, d.okved_code
  from public.companies_directory d
  where d.website is not null and d.website <> ''
    and d.revenue between p_min_revenue and p_max_revenue
    and coalesce(d.employees_count, 0) >= p_min_employees
    and coalesce(d.okved_code, '') !~ '^(47|55|56|96)'
    and (p_okved_regex is null or p_okved_regex = '' or coalesce(d.okved_code, '') ~ p_okved_regex)
    and (d.registry_status is null or d.registry_status ilike 'действ%')
  order by random()
  limit least(greatest(p_limit, 1), 50000);
$$;
revoke all on function public.polza_ru_directory_candidates_v2(bigint, bigint, integer, text, integer) from public;
grant execute on function public.polza_ru_directory_candidates_v2(bigint, bigint, integer, text, integer) to service_role;
