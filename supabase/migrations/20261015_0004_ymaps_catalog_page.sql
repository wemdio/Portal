-- Каталог Яндекс Карт по порциям (15.10.2026): вместо одного большого запроса
-- читаем каталог по ключу yandex_id (уникальный индекс), страница за страницей.
-- Возвращает подходящие строки порции и последний просмотренный id — курсор.
CREATE OR REPLACE FUNCTION public.polza_ru_ymaps_catalog_page(
  p_after text,
  p_page integer,
  p_category_regex text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  WITH page AS (
    SELECT c.yandex_id, c.name, c.website, c.email, c.categories, c.subcategories, c.query, c.country, c.closed_suspected_at
    FROM public.yandex_maps_company_catalog c
    WHERE (p_after IS NULL OR p_after = '' OR c.yandex_id > p_after)
    ORDER BY c.yandex_id
    LIMIT least(greatest(p_page, 1), 100000)
  ),
  matched AS (
    SELECT yandex_id, name, website, email, categories
    FROM page
    WHERE website IS NOT NULL AND website <> ''
      AND (country IS NULL OR country ILIKE 'росс%')
      AND closed_suspected_at IS NULL
      AND length(COALESCE(categories, '')) < 400
      AND (COALESCE(categories, '') || ' | ' || COALESCE(subcategories, '') || ' | ' || COALESCE(query, '')) ~* p_category_regex
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM matched m), '[]'::jsonb),
    'last_id', (SELECT max(yandex_id) FROM page),
    'scanned', (SELECT count(*) FROM page),
    'done', (SELECT count(*) FROM page) < least(greatest(p_page, 1), 100000)
  );
$$;

REVOKE ALL ON FUNCTION public.polza_ru_ymaps_catalog_page(text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.polza_ru_ymaps_catalog_page(text, integer, text) TO service_role;
