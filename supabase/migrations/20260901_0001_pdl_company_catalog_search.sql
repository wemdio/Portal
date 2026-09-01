-- Shared filter-first reader for the EU/US company catalog UI, exports and ENG.
-- Keeping the filtered rows materialized prevents PostgreSQL from choosing the
-- primary-key scan that previously timed out behind Kong on broad filters.

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
        select p.id, p.name, p.website, p.industry, p.size, p.country,
               p.region, p.locality, p.description
        from public.pdl_companies p
        where (p_industries is null or p.industry = any(p_industries))
          and (p_sizes is null or p.size = any(p_sizes))
          and (p_countries is null or p.country = any(p_countries))
          and (p_name is null or p.name ilike '%' || p_name || '%')
      )
      select * from m
      where (p_after_id is null or m.id > p_after_id)
      order by m.id
      limit greatest(1, least(coalesce(p_limit, 1000), 100000))
    ) sub
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.search_pdl_companies(text[], text[], text[], text, text, int)
  to service_role, authenticated;
