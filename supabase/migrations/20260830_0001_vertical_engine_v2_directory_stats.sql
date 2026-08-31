-- Honest directory funnel for the isolated Vertical Engine v2 dossier.
--
-- companies_directory can contain several source rows for one legal entity.
-- This RPC keeps the shared companies_directory_count_rpc untouched and
-- aggregates a v2-only market snapshot at company (INN) level. Rows without
-- an INN cannot be safely merged and therefore retain a deterministic row key.

create or replace function public.ve_directory_segment_stats(
  p_okved_prefixes text[]  default null,
  p_include_ip     boolean default false,
  p_region_tokens  text[]  default null,
  p_region_codes   text[]  default null,
  p_revenue_from   numeric default null,
  p_revenue_to     numeric default null,
  p_employees_from integer default null,
  p_employees_to   integer default null,
  p_require_email  boolean default false
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '180s'
as $$
declare
  _okved_codes text[];
  _result jsonb;
begin
  if p_okved_prefixes is not null then
    select coalesce(array_agg(distinct ok.code), array[]::text[])
      into _okved_codes
      from public.okved_reference ok,
           unnest(p_okved_prefixes) prefix
     where ok.code = prefix
        or ok.code like prefix || '.%';
  end if;

  with eligible as (
    select
      c.id as matched_row_id,
      nullif(btrim(c.inn), '') as company_inn,
      coalesce(nullif(btrim(c.inn), ''), 'row:' || c.id::text) as company_key,
      c.email,
      c.phones
    from public.companies_directory c
    where
      (p_okved_prefixes is null
        or c.okved_code = any(_okved_codes))
      and (p_include_ip or c.name not ilike 'ИП %')
      and (p_region_codes is null or c.region_code = any(p_region_codes))
      and (
        p_region_tokens is null
        or p_region_codes is not null
        or exists (
          select 1
            from unnest(p_region_tokens) region_token
           where c.address ilike '%' || region_token || '%'
        )
      )
      and (p_revenue_from is null or c.revenue >= p_revenue_from)
      and (p_revenue_to is null or c.revenue <= p_revenue_to)
      and (p_employees_from is null or c.employees_count >= p_employees_from)
      and (p_employees_to is null or c.employees_count <= p_employees_to)
      and (not p_require_email or nullif(btrim(c.email), '') is not null)
  ),
  qualifying_companies as (
    select
      company_key,
      max(company_inn) as company_inn,
      min(matched_row_id) as matched_row_id
    from eligible
    group by company_key
  ),
  matched_contact_rollup as (
    select
      company_key,
      bool_or(nullif(btrim(email), '') is not null) as has_email,
      bool_or(nullif(btrim(phones), '') is not null) as has_phone
    from eligible
    group by company_key
  ),
  known_contact_rows as (
    -- Для компании с ИНН контакт мог приехать другой source-строкой,
    -- которая сама не прошла revenue/employees/region фильтр текущего среза.
    select
      q.company_key,
      known_row.email,
      known_row.phones
    from qualifying_companies q
    join public.companies_directory known_row
      on nullif(btrim(known_row.inn), '') = q.company_inn
    where q.company_inn is not null

    union all

    -- Строки без ИНН намеренно не склеиваем: известен только контакт той
    -- конкретной qualifying-строки, иначе одноимённые компании смешаются.
    select
      q.company_key,
      known_row.email,
      known_row.phones
    from qualifying_companies q
    join public.companies_directory known_row
      on known_row.id = q.matched_row_id
    where q.company_inn is null
  ),
  known_contact_rollup as (
    select
      company_key,
      bool_or(nullif(btrim(email), '') is not null) as has_email,
      bool_or(nullif(btrim(phones), '') is not null) as has_phone
    from known_contact_rows
    group by company_key
  ),
  totals as (
    select
      (select count(*) from eligible) as directory_rows_total,
      count(*) as companies_unique_total,
      count(*) filter (where known.has_email) as companies_with_email,
      count(*) filter (where known.has_phone) as companies_with_phone,
      count(*) filter (
        where known.has_email or known.has_phone
      ) as companies_with_any_contact,
      count(*) filter (where matched.has_email) as matched_companies_with_email,
      count(*) filter (where matched.has_phone) as matched_companies_with_phone,
      count(*) filter (
        where matched.has_email or matched.has_phone
      ) as matched_companies_with_any_contact
    from qualifying_companies q
    join known_contact_rollup known using (company_key)
    join matched_contact_rollup matched using (company_key)
  )
  select jsonb_build_object(
    'directory_rows_total', directory_rows_total,
    'companies_unique_total', companies_unique_total,
    'companies_with_email', companies_with_email,
    'companies_with_phone', companies_with_phone,
    'companies_with_any_contact', companies_with_any_contact,
    'matched_companies_with_email', matched_companies_with_email,
    'matched_companies_with_phone', matched_companies_with_phone,
    'matched_companies_with_any_contact', matched_companies_with_any_contact
  )
    into _result
    from totals;

  return coalesce(_result, jsonb_build_object(
    'directory_rows_total', 0,
    'companies_unique_total', 0,
    'companies_with_email', 0,
    'companies_with_phone', 0,
    'companies_with_any_contact', 0,
    'matched_companies_with_email', 0,
    'matched_companies_with_phone', 0,
    'matched_companies_with_any_contact', 0
  ));
end;
$$;

revoke all on function public.ve_directory_segment_stats(
  text[], boolean, text[], text[], numeric, numeric, integer, integer, boolean
) from public, anon, authenticated;

grant execute on function public.ve_directory_segment_stats(
  text[], boolean, text[], text[], numeric, numeric, integer, integer, boolean
) to service_role, postgres;
