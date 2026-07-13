-- Seen-журнал B2B-поиска: какие компании клиент уже выгружал и когда.
--
-- Зачем: выгрузка companies_directory идёт строго ORDER BY id с offset 0 —
-- клиент с лимитом 20k/мес и 60k компаний под фильтром каждый месяц получал
-- ОДНИ И ТЕ ЖЕ первые 20k (и повторно слал им письма). Журнал позволяет
-- исключать уже выданное: месяц 1 → компании 1..20k, месяц 2 → следующие.
--
-- Политика (решение 10.07.2026): журнал БЕССРОЧНЫЙ, повтор уже выгруженных —
-- только явной галочкой «показать уже выгруженных» (include_seen). Бэкфилл
-- для существующих клиентов — админский импорт их старых CSV по ИНН
-- (source='backfill_csv').

create table if not exists public.client_companies_search_seen (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  company_id  bigint      not null,
  exported_at timestamptz not null default now(),
  source      text        not null default 'export',
  primary key (user_id, company_id)
);

alter table public.client_companies_search_seen enable row level security;

grant select, insert, delete on public.client_companies_search_seen to service_role;

-- ── Пересоздаём RPC с параметром p_exclude_user (uuid, default null) ────────
-- При null поведение байт-в-байт прежнее (авто-пайплайн/скорер не затронуты).
-- При заданном user_id из выдачи исключаются компании из seen-журнала.
-- Сигнатура меняется → старые перегрузки дропаем (иначе PostgREST ambiguity).

drop function if exists public.companies_directory_count_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], text[]
);
drop function if exists public.companies_directory_fetch_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], int, int, text[]
);

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
    select array_agg(distinct ok.code) into _okved_codes
    from okved_reference ok, unnest(p_okved_prefixes) px
    where ok.code = px or ok.code like px || '.%';
  end if;

  select count(*) into _result
  from public.companies_directory c
  where
    (p_region_codes is null or c.region_code = any(p_region_codes))
    and (p_region_tokens is null or p_region_codes is not null
         or exists (select 1 from unnest(p_region_tokens) t where c.address ilike '%' || t || '%'))
    and (p_activity_types is null or c.activity_type = any(p_activity_types))
    and (_okved_codes is null or c.okved_code = any(_okved_codes))
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
    select array_agg(distinct ok.code) into _okved_codes
    from okved_reference ok, unnest(p_okved_prefixes) px
    where ok.code = px or ok.code like px || '.%';
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
        (p_region_codes is null or c.region_code = any(p_region_codes))
        and (p_region_tokens is null or p_region_codes is not null
             or exists (select 1 from unnest(p_region_tokens) t where c.address ilike '%' || t || '%'))
        and (p_activity_types is null or c.activity_type = any(p_activity_types))
        and (_okved_codes is null or c.okved_code = any(_okved_codes))
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
