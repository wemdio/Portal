-- Exact company registry data from DaData.
--
-- `okved_code` is retained as the approximate code derived from the source
-- activity taxonomy. `okved_code_exact` is the official main OKVED returned
-- for a concrete INN. Search prefers the exact value when it exists and falls
-- back to the mapped value for rows that have not been enriched yet.

alter table public.companies_directory
  add column if not exists okved_code_exact text,
  add column if not exists registration_date date,
  add column if not exists registry_status text,
  add column if not exists okved_exact_source text,
  add column if not exists dadata_enrichment_status text,
  add column if not exists dadata_enriched_at timestamptz;

comment on column public.companies_directory.okved_code_exact is
  'Official main OKVED for the company INN. Unlike okved_code, this is not inferred from activity_type.';
comment on column public.companies_directory.okved_code is
  'Approximate OKVED derived from the source activity_type taxonomy; use okved_code_exact when available.';
comment on column public.companies_directory.registration_date is
  'Official company registration date returned by the registry enrichment source.';
comment on column public.companies_directory.registry_status is
  'Registry status returned by the enrichment source (for example ACTIVE or LIQUIDATED).';
comment on column public.companies_directory.dadata_enrichment_status is
  'Result of the last DaData enrichment: success or not_found.';

create index if not exists companies_directory_okved_exact_prefix_idx
  on public.companies_directory (okved_code_exact text_pattern_ops)
  where okved_code_exact is not null;

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
  p_okved_prefixes  text[]  default null,
  p_region_codes    text[]  default null,
  p_exclude_user    uuid    default null
)
returns bigint
language plpgsql stable
set statement_timeout = '180s'
as $$
declare
  _okved_codes text[];
  _result bigint;
begin
  if p_okved_prefixes is not null then
    with recursive picked(code) as (
      select r.code
      from public.okved_reference r
      where r.code = any(p_okved_prefixes)

      union

      select ch.code
      from public.okved_reference ch
      join picked p on ch.parent_code = p.code
    )
    select array_agg(distinct code) into _okved_codes
    from picked;
  end if;

  select count(*) into _result
  from public.companies_directory c
  where
    (p_region_codes is null or c.region_code = any(p_region_codes))
    and (p_region_tokens is null or p_region_codes is not null
         or exists (select 1 from unnest(p_region_tokens) t where c.address ilike '%' || t || '%'))
    and (p_activity_types is null or c.activity_type = any(p_activity_types))
    and (
      p_okved_prefixes is null
      or (
        c.okved_code_exact is not null
        and (
          (_okved_codes is not null and c.okved_code_exact = any(_okved_codes))
          or exists (
            select 1
            from unnest(p_okved_prefixes) px
            where px ~ '^[0-9]{2}([.][0-9]{1,2}){0,2}$'
              and starts_with(c.okved_code_exact, px)
          )
        )
      )
      or (
        c.okved_code_exact is null
        and _okved_codes is not null
        and c.okved_code = any(_okved_codes)
      )
    )
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
    and (p_exclude_user is null or not exists (
      select 1 from public.client_companies_search_seen s
      where s.user_id = p_exclude_user and s.company_id = c.id
    ));

  return _result;
end;
$$;

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
  p_offset          int     default 0,
  p_region_codes    text[]  default null,
  p_exclude_user    uuid    default null
)
returns jsonb
language plpgsql stable
set statement_timeout = '180s'
as $$
declare
  _okved_codes text[];
begin
  if p_okved_prefixes is not null then
    with recursive picked(code) as (
      select r.code
      from public.okved_reference r
      where r.code = any(p_okved_prefixes)

      union

      select ch.code
      from public.okved_reference ch
      join picked p on ch.parent_code = p.code
    )
    select array_agg(distinct code) into _okved_codes
    from picked;
  end if;

  return coalesce((
    select jsonb_agg(row_to_json(sub))
    from (
      select c.id, c.name, c.inn, c.kpp, c.address, c.phones, c.email,
             c.employees_count, c.revenue, c.cost, c.activity_type,
             c.website, c.edo_id, c.egais, c.ogrn,
             coalesce(c.okved_code_exact, c.okved_code) as okved_code,
             c.okved_code as okved_code_mapped,
             c.okved_code_exact,
             c.registration_date,
             c.registry_status,
             c.okved_exact_source,
             ok.name as okved_name
      from public.companies_directory c
      left join public.okved_reference ok
        on ok.code = coalesce(c.okved_code_exact, c.okved_code)
      where
        (p_region_codes is null or c.region_code = any(p_region_codes))
        and (p_region_tokens is null or p_region_codes is not null
             or exists (select 1 from unnest(p_region_tokens) t where c.address ilike '%' || t || '%'))
        and (p_activity_types is null or c.activity_type = any(p_activity_types))
        and (
          p_okved_prefixes is null
          or (
            c.okved_code_exact is not null
            and (
              (_okved_codes is not null and c.okved_code_exact = any(_okved_codes))
              or exists (
                select 1
                from unnest(p_okved_prefixes) px
                where px ~ '^[0-9]{2}([.][0-9]{1,2}){0,2}$'
                  and starts_with(c.okved_code_exact, px)
              )
            )
          )
          or (
            c.okved_code_exact is null
            and _okved_codes is not null
            and c.okved_code = any(_okved_codes)
          )
        )
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
        and (p_exclude_user is null or not exists (
          select 1 from public.client_companies_search_seen s
          where s.user_id = p_exclude_user and s.company_id = c.id
        ))
      order by c.id
      limit p_limit
      offset p_offset
    ) sub
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.companies_directory_count_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], text[], uuid
) to service_role, authenticated;

grant execute on function public.companies_directory_fetch_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], int, int, text[], uuid
) to service_role, authenticated;
