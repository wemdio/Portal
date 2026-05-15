-- RPC для получения списка уникальных report_year в fns_revenue.
--
-- Зачем функция, а не обычный select: PostgREST через supabase-js не умеет
-- SELECT DISTINCT. Попытка достать года через
--   .select('report_year').order(...).limit(N)
-- берёт N произвольных СТРОК, а не N уникальных годов — на таблице с
-- ~2M строк одного года все N строк будут одним годом, и UI-селектор
-- покажет только его. Это и был баг: 2025 не появлялся в списке.
--
-- Функция возвращает массив годов по убыванию (новейший первым) —
-- ровно то, что нужно для рендера чекбоксов.
--
-- STABLE: результат не меняется в пределах одного запроса, планировщик
-- может кешировать. security definer не нужен — RLS на fns_revenue
-- разрешает SELECT всем authenticated.

create or replace function public.get_fns_revenue_years()
returns integer[]
language sql
stable
as $$
  select coalesce(
    array_agg(distinct report_year order by report_year desc),
    '{}'::integer[]
  )
  from public.fns_revenue;
$$;

grant execute on function public.get_fns_revenue_years() to authenticated;
grant execute on function public.get_fns_revenue_years() to service_role;
