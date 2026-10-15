-- ОКВЭД в общей базе компаний хранится с разной точностью: «62.0», «41.2», «46»
-- (у ~30% строк), точный код (okved_code_exact) есть у ~70%. Фильтр «62.01»
-- по одному okved_code пропускал компании с «62.0» (IT: 124 вместо тысяч).
-- v3: берём точный код, если он есть, иначе общий, и сравниваем по префиксу в
-- обе стороны: «62.0» подходит к запросу «62.01», а «62.01» — к «62.01.1».
-- (15.10.2026)

CREATE OR REPLACE FUNCTION public.polza_ru_directory_candidates_v3(
  p_min_revenue bigint,
  p_max_revenue bigint,
  p_min_employees integer,
  p_okved_prefixes text[],
  p_limit integer
)
RETURNS TABLE (inn text, name text, website text, email text, revenue bigint, employees_count integer, okved_code text)
LANGUAGE sql
VOLATILE
SET statement_timeout = '120s'
AS $$
  SELECT d.inn, d.name, d.website, d.email, d.revenue, d.employees_count,
         COALESCE(d.okved_code_exact, d.okved_code) AS okved_code
  FROM public.companies_directory d
  WHERE d.website IS NOT NULL AND d.website <> ''
    AND d.revenue BETWEEN p_min_revenue AND p_max_revenue
    AND COALESCE(d.employees_count, 0) >= p_min_employees
    AND COALESCE(d.okved_code_exact, d.okved_code, '') !~ '^(47|55|56|96)'
    AND (d.registry_status IS NULL OR d.registry_status ILIKE 'действ%')
    AND (
      p_okved_prefixes IS NULL OR cardinality(p_okved_prefixes) = 0
      OR EXISTS (
        SELECT 1 FROM unnest(p_okved_prefixes) AS pre
        WHERE length(COALESCE(d.okved_code_exact, d.okved_code, '')) >= 2
          AND (COALESCE(d.okved_code_exact, d.okved_code) LIKE pre || '%'
               OR pre LIKE COALESCE(d.okved_code_exact, d.okved_code) || '%')
      )
    )
  ORDER BY random()
  LIMIT least(greatest(p_limit, 1), 100000);
$$;

REVOKE ALL ON FUNCTION public.polza_ru_directory_candidates_v3(bigint, bigint, integer, text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.polza_ru_directory_candidates_v3(bigint, bigint, integer, text[], integer) TO service_role;

-- Список кодов для выбора галочками на экране запуска: код, сколько компаний,
-- название вида деятельности из базы. Кодов с малым числом компаний не берём.
CREATE OR REPLACE FUNCTION public.polza_ru_okved_options()
RETURNS TABLE (code text, companies bigint, name text)
LANGUAGE sql
STABLE
SET statement_timeout = '60s'
AS $$
  SELECT COALESCE(d.okved_code_exact, d.okved_code) AS code,
         count(*) AS companies,
         max(d.activity_type) AS name
  FROM public.companies_directory d
  WHERE COALESCE(d.okved_code_exact, d.okved_code, '') ~ '^\d\d'
  GROUP BY 1
  HAVING count(*) >= 200
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.polza_ru_okved_options() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.polza_ru_okved_options() TO service_role;
