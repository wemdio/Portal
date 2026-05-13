-- Оптимизация RPC: регионы через один regex (~*) вместо EXISTS + unnest + ILIKE
-- Это даёт одно сканирование вместо N (по кол-ву токенов).
-- statement_timeout = 180s для тяжёлых запросов.

-- ── Count ─────────────────────────────────────────────────────────────
create or replace function public.companies_directory_count_rpc(
  p_region_tokens   text[]  default null,
  p_activity_types  text[]  default null,
  p_has_phone       boolean default false,
  p_has_email       boolean default false,
  p_legal_forms     text[]  default null,
  p_has_website     boolean default false,
  p_has_edo         boolean default false,
  p_has_egais       boolean default false,
  p_include_ip      boolean default true,
  p_revenue_from    numeric default null,
  p_revenue_to      numeric default null,
  p_cost_from       numeric default null,
  p_cost_to         numeric default null,
  p_employees_from  int     default null,
  p_employees_to    int     default null,
  p_inn_list        text[]  default null,
  p_okved_prefixes  text[]  default null
)
returns bigint
language plpgsql stable
set statement_timeout = '180s'
as $$
declare
  region_pattern text;
  result bigint;
begin
  if p_region_tokens is not null then
    region_pattern := array_to_string(p_region_tokens, '|');
  end if;

  select count(*) into result
  from public.companies_directory c
  where
    (region_pattern is null or c.address ~* region_pattern)
    and (p_activity_types is null or c.activity_type = any(p_activity_types))
    and (p_okved_prefixes is null or exists (
      select 1 from unnest(p_okved_prefixes) px
      where c.okved_code is not null
        and (c.okved_code = px or c.okved_code like px || '.%')
    ))
    and (not p_has_phone  or c.phones is not null)
    and (not p_has_email  or c.email  is not null)
    and (p_legal_forms is null or exists (
      select 1 from unnest(p_legal_forms) f where c.name ilike f || '%'
    ))
    and (not p_has_website or c.website is not null)
    and (not p_has_edo     or c.edo_id  is not null)
    and (not p_has_egais   or c.egais   is not null)
    and (p_include_ip or c.name not ilike 'ИП %')
    and (p_revenue_from   is null or c.revenue         >= p_revenue_from)
    and (p_revenue_to     is null or c.revenue         <= p_revenue_to)
    and (p_cost_from      is null or c.cost            >= p_cost_from)
    and (p_cost_to        is null or c.cost            <= p_cost_to)
    and (p_employees_from is null or c.employees_count >= p_employees_from)
    and (p_employees_to   is null or c.employees_count <= p_employees_to)
    and (p_inn_list is null or c.inn = any(p_inn_list));

  return result;
end;
$$;

-- ── Fetch rows (paginated) ────────────────────────────────────────────
create or replace function public.companies_directory_fetch_rpc(
  p_region_tokens   text[]  default null,
  p_activity_types  text[]  default null,
  p_has_phone       boolean default false,
  p_has_email       boolean default false,
  p_legal_forms     text[]  default null,
  p_has_website     boolean default false,
  p_has_edo         boolean default false,
  p_has_egais       boolean default false,
  p_include_ip      boolean default true,
  p_revenue_from    numeric default null,
  p_revenue_to      numeric default null,
  p_cost_from       numeric default null,
  p_cost_to         numeric default null,
  p_employees_from  int     default null,
  p_employees_to    int     default null,
  p_inn_list        text[]  default null,
  p_okved_prefixes  text[]  default null,
  p_limit           int     default 25,
  p_offset          int     default 0
)
returns jsonb
language plpgsql stable
set statement_timeout = '180s'
as $$
declare
  region_pattern text;
begin
  if p_region_tokens is not null then
    region_pattern := array_to_string(p_region_tokens, '|');
  end if;

  return coalesce((
    select jsonb_agg(row_to_json(sub))
    from (
      select c.id, c.name, c.inn, c.kpp, c.address, c.phones, c.email,
             c.employees_count, c.revenue, c.cost, c.activity_type,
             c.website, c.edo_id, c.egais, c.ogrn,
             c.okved_code,
             ok.name as okved_name
      from public.companies_directory c
      left join public.okved_reference ok on ok.code = c.okved_code
      where
        (region_pattern is null or c.address ~* region_pattern)
        and (p_activity_types is null or c.activity_type = any(p_activity_types))
        and (p_okved_prefixes is null or exists (
          select 1 from unnest(p_okved_prefixes) px
          where c.okved_code is not null
            and (c.okved_code = px or c.okved_code like px || '.%')
        ))
        and (not p_has_phone  or c.phones is not null)
        and (not p_has_email  or c.email  is not null)
        and (p_legal_forms is null or exists (
          select 1 from unnest(p_legal_forms) f where c.name ilike f || '%'
        ))
        and (not p_has_website or c.website is not null)
        and (not p_has_edo     or c.edo_id  is not null)
        and (not p_has_egais   or c.egais   is not null)
        and (p_include_ip or c.name not ilike 'ИП %')
        and (p_revenue_from   is null or c.revenue         >= p_revenue_from)
        and (p_revenue_to     is null or c.revenue         <= p_revenue_to)
        and (p_cost_from      is null or c.cost            >= p_cost_from)
        and (p_cost_to        is null or c.cost            <= p_cost_to)
        and (p_employees_from is null or c.employees_count >= p_employees_from)
        and (p_employees_to   is null or c.employees_count <= p_employees_to)
        and (p_inn_list is null or c.inn = any(p_inn_list))
      order by c.id
      limit p_limit
      offset p_offset
    ) sub
  ), '[]'::jsonb);
end;
$$;

-- GIN index for regex (~*) on address — trgm supports regex matching
create index if not exists companies_directory_address_trgm_idx
  on public.companies_directory using gin (address gin_trgm_ops);

grant execute on function public.companies_directory_count_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[]
) to service_role, authenticated;

grant execute on function public.companies_directory_fetch_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], int, int
) to service_role, authenticated;
