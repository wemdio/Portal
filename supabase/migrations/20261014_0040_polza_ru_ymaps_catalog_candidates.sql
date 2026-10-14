-- Каталог Яндекс Карт (~10 млн организаций) как источник RU автоаутрича:
-- компании с сайтом по рубрикам ЦА (14.10.2026, «до конца месяца 15к базы»).
-- tablesample — случайные страницы таблицы: каждый запуск берёт свою часть
-- каталога, а запрос не сканирует все 21 ГБ.
create or replace function public.polza_ru_ymaps_catalog_candidates(
  p_category_regex text,
  p_sample_percent real,
  p_limit integer
)
returns table (
  yandex_id text,
  name text,
  website text,
  email text,
  categories text,
  city text
)
language sql
volatile
set statement_timeout = '300s'
as $$
  select c.yandex_id, c.name, c.website, c.email, c.categories, c.city
  from public.yandex_maps_company_catalog c tablesample system (least(greatest(p_sample_percent, 0.1), 100))
  where c.website is not null and c.website <> ''
    and (c.country is null or c.country ilike 'росс%')
    and c.closed_suspected_at is null
    -- У части карточек в categories лежит весь текст страницы («Силикатный
    -- завод» — остановка рядом с «Пятёрочкой»): такие пропускаем, ищем по
    -- рубрике, подрубрикам и поисковому запросу, по которому карточку собрали.
    and length(coalesce(c.categories, '')) < 400
    and (coalesce(c.categories, '') || ' | ' || coalesce(c.subcategories, '') || ' | ' || coalesce(c.query, '')) ~* p_category_regex
  limit least(greatest(p_limit, 1), 50000);
$$;
revoke all on function public.polza_ru_ymaps_catalog_candidates(text, real, integer) from public;
grant execute on function public.polza_ru_ymaps_catalog_candidates(text, real, integer) to service_role;
