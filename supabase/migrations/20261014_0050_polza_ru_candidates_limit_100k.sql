-- Потолок выборки кандидатов RU автоаутрича: 50 000 → 100 000 (решение 14.10.2026:
-- просмотр 100 000, лимит запуска 3 ч). Тела функций те же, меняется только limit.
create or replace function public.polza_ru_directory_candidates_v2(
  p_min_revenue bigint,
  p_max_revenue bigint,
  p_min_employees integer,
  p_okved_regex text,
  p_limit integer
)
returns table (inn text, name text, website text, email text, revenue bigint, employees_count integer, okved_code text)
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
  limit least(greatest(p_limit, 1), 100000);
$$;

create or replace function public.polza_ru_ymaps_catalog_candidates(
  p_category_regex text,
  p_sample_percent real,
  p_limit integer
)
returns table (yandex_id text, name text, website text, email text, categories text, city text)
language sql
volatile
set statement_timeout = '300s'
as $$
  select c.yandex_id, c.name, c.website, c.email, c.categories, c.city
  from public.yandex_maps_company_catalog c tablesample system (least(greatest(p_sample_percent, 0.1), 100))
  where c.website is not null and c.website <> ''
    and (c.country is null or c.country ilike 'росс%')
    and c.closed_suspected_at is null
    and length(coalesce(c.categories, '')) < 400
    and (coalesce(c.categories, '') || ' | ' || coalesce(c.subcategories, '') || ' | ' || coalesce(c.query, '')) ~* p_category_regex
  limit least(greatest(p_limit, 1), 100000);
$$;
