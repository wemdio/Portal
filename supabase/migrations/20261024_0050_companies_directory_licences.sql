-- «База баз»: лицензии компаний по единому реестру МСП ФНС как фильтр выборки.
--
-- В реестре МСП у лицензии есть вид деятельности (СвЛиценз/НаимЛицВД). Это точнее
-- ОКВЭД: код 86 стоит у любой компании, лицензия на медицинскую деятельность —
-- только у клиники. Группы (medical, pharma, education, alcohol_retail…) задаёт
-- app/src/lib/companiesDirectory/licences.ts, загрузку — scripts/fns-sme-licences.ts
-- (снимок раз в месяц, после «да» владельца). Миграция данные не загружает.
--
-- Выборка и подсчёт реестра получают необязательный p_licence_groups (default null):
-- компания проходит, если у её ИНН есть хотя бы одна из групп. При null поведение
-- прежнее. Сигнатура меняется, поэтому старые перегрузки удаляются (иначе PostgREST
-- не выберет функцию), как в 20260712_0001. Код передаёт параметр только когда
-- фильтр задан, поэтому прежние вызовы работают и до, и после миграции.
--
-- ve_directory_plan_population (размер плана VE2) читает тот же фильтр из ключа
-- licence_groups среза; сигнатура, security invoker, search_path и права не меняются.
--
-- Повторный запуск безопасен: if not exists, drop if exists и create or replace.

create table if not exists public.companies_directory_licences (
  inn text primary key check (inn ~ '^[0-9]{10}$'),
  groups text[] not null check (cardinality(groups) > 0),
  activities text[] not null default '{}',
  snapshot_date date not null,
  updated_at timestamp with time zone not null default now()
);

comment on table public.companies_directory_licences is
  'Группы лицензий юрлица по единому реестру МСП ФНС (снимок snapshot_date); фильтр licenceGroups выборки реестра и VE2.';

create index if not exists companies_directory_licences_groups_idx
  on public.companies_directory_licences using gin (groups);

alter table public.companies_directory_licences enable row level security;
revoke all on table public.companies_directory_licences from anon, authenticated;
-- Загрузчик и воркеры работают под service_role.
grant all on public.companies_directory_licences to service_role;
-- Как у companies_directory: функции выборки — security invoker, и у
-- authenticated есть execute. Без табличного права их вызов падал бы на любом
-- фильтре; политик RLS нет, поэтому строк эта роль всё равно не видит.
grant select on public.companies_directory_licences to authenticated;

drop function if exists public.companies_directory_count_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], text[], uuid
);
drop function if exists public.companies_directory_fetch_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], int, int, text[], uuid
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
  p_exclude_user    uuid    default null,
  p_licence_groups  text[]  default null
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
    and (p_licence_groups is null or exists (
      select 1 from public.companies_directory_licences l
      where l.inn = c.inn and l.groups && p_licence_groups
    ))
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
  p_exclude_user    uuid    default null,
  p_licence_groups  text[]  default null
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
        and (p_licence_groups is null or exists (
          select 1 from public.companies_directory_licences l
          where l.inn = c.inn and l.groups && p_licence_groups
        ))
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

-- Права новых сигнатур. Прежние функции исполнялись всеми (PUBLIC и anon получили
-- execute ещё до локдауна 20261015_0036). Новые функции по правилу локдауна PUBLIC и
-- anon не получают: anon ни один путь не вызывает, всё идёт через API под
-- service_role. Явно — те же роли, что и раньше без PUBLIC: service_role,
-- authenticated, postgres и прямые логины чтения (как direct_fn_roles в 0036).
revoke all on function public.companies_directory_count_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], text[], uuid, text[]
) from public, anon;
revoke all on function public.companies_directory_fetch_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], int, int, text[], uuid, text[]
) from public, anon;

grant execute on function public.companies_directory_count_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], text[], uuid, text[]
) to service_role, authenticated, postgres;

grant execute on function public.companies_directory_fetch_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], int, int, text[], uuid, text[]
) to service_role, authenticated, postgres;

do $$
declare
  r text;
begin
  foreach r in array array['readonly', 'nick_ro', 'supabase_auth_admin'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r and not rolsuper) then
      execute format('grant execute on function public.companies_directory_count_rpc(text[], text[], boolean, boolean, text[], boolean, boolean, boolean, boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], text[], uuid, text[]) to %I', r);
      execute format('grant execute on function public.companies_directory_fetch_rpc(text[], text[], boolean, boolean, text[], boolean, boolean, boolean, boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], int, int, text[], uuid, text[]) to %I', r);
      -- Функции ссылаются на таблицу лицензий; без права чтения общий план запроса
      -- падал бы и на вызове без фильтра.
      execute format('grant select on public.companies_directory_licences to %I', r);
    end if;
  end loop;
end $$;

create or replace function public.ve_directory_plan_population(
  p_slices       jsonb,
  p_exclude_inns text[] default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '180s'
as $$
  with recursive slices as (
    select
      s.ord::integer as ord,
      case when jsonb_typeof(s.v -> 'okved_prefixes') = 'array' and jsonb_array_length(s.v -> 'okved_prefixes') > 0
        then array(select jsonb_array_elements_text(s.v -> 'okved_prefixes')) end as okved_prefixes,
      case when jsonb_typeof(s.v -> 'region_codes') = 'array' and jsonb_array_length(s.v -> 'region_codes') > 0
        then array(select jsonb_array_elements_text(s.v -> 'region_codes')) end as region_codes,
      coalesce((s.v ->> 'include_ip')::boolean, false) as include_ip,
      coalesce((s.v ->> 'has_email')::boolean, false) as has_email,
      (s.v ->> 'revenue_from')::numeric as revenue_from,
      (s.v ->> 'revenue_to')::numeric as revenue_to,
      (s.v ->> 'employees_from')::numeric as employees_from,
      (s.v ->> 'employees_to')::numeric as employees_to,
      (s.v ->> 'keep_revenue_from')::numeric as keep_revenue_from,
      (s.v ->> 'keep_revenue_to')::numeric as keep_revenue_to,
      (s.v ->> 'keep_employees_from')::numeric as keep_employees_from,
      (s.v ->> 'keep_employees_to')::numeric as keep_employees_to,
      case when jsonb_typeof(s.v -> 'licence_groups') = 'array' and jsonb_array_length(s.v -> 'licence_groups') > 0
        then array(select jsonb_array_elements_text(s.v -> 'licence_groups')) end as licence_groups
    from jsonb_array_elements(coalesce(p_slices, '[]'::jsonb)) with ordinality as s(v, ord)
  ),
  -- Коды ОКВЭД раскрываются так же, как в companies_directory_fetch_rpc.
  picked(ord, code) as (
    select sl.ord, r.code
      from slices sl
      join public.okved_reference r on r.code = any(sl.okved_prefixes)
    union
    select p.ord, ch.code
      from picked p
      join public.okved_reference ch on ch.parent_code = p.code
  ),
  -- materialized: иначе подзапрос кодов считается заново на каждой строке реестра.
  slice_codes as materialized (
    select sl.*, (select array_agg(distinct p.code) from picked p where p.ord = sl.ord) as okved_codes
      from slices sl
  ),
  matched as materialized (
    select
      sl.ord,
      c.id,
      coalesce(nullif(btrim(c.inn), ''), 'row:' || c.id::text) as company_key,
      nullif(regexp_replace(coalesce(c.inn, ''), '[^0-9]', '', 'g'), '') as inn_digits,
      nullif(btrim(c.email), '') is not null as email_present,
      nullif(btrim(c.phones), '') is not null as phone_present
    from public.companies_directory c
    join slice_codes sl on
      (sl.region_codes is null or c.region_code = any(sl.region_codes))
      and (
        sl.okved_prefixes is null
        or (
          c.okved_code_exact is not null
          and (
            (sl.okved_codes is not null and c.okved_code_exact = any(sl.okved_codes))
            or exists (
              select 1
                from unnest(sl.okved_prefixes) px
               where px ~ '^[0-9]{2}([.][0-9]{1,2}){0,2}$'
                 and starts_with(c.okved_code_exact, px)
            )
          )
        )
        or (
          c.okved_code_exact is null
          and sl.okved_codes is not null
          and c.okved_code = any(sl.okved_codes)
        )
      )
      and (not sl.has_email or c.email is not null)
      and (sl.include_ip or c.name not ilike 'ИП %')
      and (sl.revenue_from is null or c.revenue >= sl.revenue_from)
      and (sl.revenue_to is null or c.revenue <= sl.revenue_to)
      and (sl.employees_from is null or c.employees_count >= sl.employees_from)
      and (sl.employees_to is null or c.employees_count <= sl.employees_to)
      and (sl.keep_revenue_from is null or c.revenue is null or c.revenue >= sl.keep_revenue_from)
      and (sl.keep_revenue_to is null or c.revenue is null or c.revenue <= sl.keep_revenue_to)
      and (sl.keep_employees_from is null or c.employees_count is null or c.employees_count >= sl.keep_employees_from)
      and (sl.keep_employees_to is null or c.employees_count is null or c.employees_count <= sl.keep_employees_to)
      and (sl.licence_groups is null or exists (
        select 1 from public.companies_directory_licences l
         where l.inn = c.inn and l.groups && sl.licence_groups
      ))
  ),
  companies as (
    select
      company_key,
      max(inn_digits) as inn_digits,
      bool_or(email_present) as email_present,
      bool_or(phone_present) as phone_present
    from matched
    group by company_key
  ),
  excluded as (
    select distinct regexp_replace(x, '[^0-9]', '', 'g') as inn
      from unnest(coalesce(p_exclude_inns, array[]::text[])) x
  ),
  per_slice as (
    select sl.ord, count(distinct m.company_key) as companies
      from slices sl
      left join matched m on m.ord = sl.ord
     group by sl.ord
  )
  select jsonb_build_object(
    'directory_rows_total', (select count(distinct id) from matched),
    'companies_unique_total', (select count(*) from companies),
    'companies_available', (
      select count(*) from companies c
       where c.inn_digits is null
          or not exists (select 1 from excluded e where e.inn = c.inn_digits)
    ),
    'companies_with_email', (select count(*) from companies where email_present),
    'companies_with_phone', (select count(*) from companies where phone_present),
    'slice_companies', (select coalesce(jsonb_agg(companies order by ord), '[]'::jsonb) from per_slice)
  );
$$;

comment on function public.ve_directory_plan_population(jsonb, text[]) is
  'VE2: компании в объединении реестровых срезов плана по тому же условию, что companies_directory_fetch_rpc (включая группы лицензий); без двойного счёта по ИНН.';

revoke all on function public.ve_directory_plan_population(jsonb, text[]) from public, anon, authenticated;
grant execute on function public.ve_directory_plan_population(jsonb, text[]) to service_role, postgres;
