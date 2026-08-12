-- RPC чтения каталога PDL для ENG-коллекторов «Движка вертикалей» (base_collect).
--
-- Проблема: плоский PostgREST-запрос вида
--   pdl_companies?where-фильтры&order=id&limit=N
-- при широких фильтрах (несколько крупных industry × 5 стран × 4 size) на 19.5M
-- строк заставляет планировщика идти pkey-scan'ом по id с фильтрацией — 58s+
-- на страницу, Kong отвечает 504 (maintenance-страница), задача сбора падает
-- с нечитаемой HTML-простынёй в error. Узкие фильтры при этом работали нормально,
-- поэтому баг всплыл только на «широких» вертикалях (Franchise Brands).
--
-- Решение: тот же keyset (id > p_after_id, order by id, limit), но с
-- принудительным планом «сначала фильтр (индекс country,industry,size), потом
-- сортировка совпадений» через materialized CTE. Замеры на проде против
-- исходной формы: 0.6s (construction) и 39.6s (3 индустрии × 5 стран × 4
-- размера, 46k совпадений) против 58s+ timeout. statement_timeout функции 120s
-- перекрывает и широчайшие планы LLM-планировщика.

create or replace function public.search_pdl_companies(
  p_industries text[] default null,
  p_sizes      text[] default null,
  p_countries  text[] default null,
  p_name       text   default null,
  p_after_id   text   default null,
  p_limit      int    default 1000
)
returns jsonb
language plpgsql stable
set statement_timeout = '120s'
as $$
begin
  return coalesce((
    select jsonb_agg(row_to_json(sub))
    from (
      with m as materialized (
        select p.id, p.name, p.website, p.industry, p.size, p.country, p.region, p.locality
        from public.pdl_companies p
        where (p_industries is null or p.industry = any(p_industries))
          and (p_sizes is null or p.size = any(p_sizes))
          and (p_countries is null or p.country = any(p_countries))
          and (p_name is null or p.name ilike '%' || p_name || '%')
      )
      select * from m
      where (p_after_id is null or m.id > p_after_id)
      order by m.id
      limit p_limit
    ) sub
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.search_pdl_companies(text[], text[], text[], text, text, int)
  to service_role, authenticated;
