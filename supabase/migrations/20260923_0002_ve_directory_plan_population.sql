-- VE2: размер реестровой части плана тем же условием, что и выборка.
--
-- Оценка остатка рынка была пуста у всех баз. Одна из причин: население
-- считала ve_directory_segment_stats по приблизительному okved_code, а выборка
-- (companies_directory_fetch_rpc) — по точному okved_code_exact с запасным
-- okved_code, когда точного нет. Замер 22.09.2026: срез 86.2 — счётчик 0,
-- выборка 27 848; 68.3 с порогами — 0 против 69. Вторая причина: при двух и
-- более реестровых срезах размер не считался совсем, чтобы не сложить одну
-- компанию дважды.
--
-- Эта функция считает объединение всех реестровых срезов плана одним проходом
-- по companies_directory: компания (ИНН, без ИНН — строка) считается один раз,
-- сколько бы срезов её ни содержало. Условие среза повторяет fetch-RPC
-- построчно: ОКВЭД точный с запасным, регион, ИП, пороги выручки и штата,
-- «есть email». Вторая очередь (порог или пустое поле, veDirectorySizeKeep)
-- передаётся полями keep_*.
--
-- p_exclude_inns — ИНН компаний, уже взятых другими базами проекта: выборка
-- их пропускает, значит и в доступный остаток они не входят.
--
-- Функция только читает. Вызывает её воркер при смене плана и не чаще раза в
-- сутки на базу, а не опрос карточки. Миграция создаёт функцию и ничего не
-- пересчитывает.

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
      (s.v ->> 'keep_employees_to')::numeric as keep_employees_to
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
  'VE2: компании в объединении реестровых срезов плана по тому же условию, что companies_directory_fetch_rpc; без двойного счёта по ИНН.';

revoke all on function public.ve_directory_plan_population(jsonb, text[]) from public, anon, authenticated;
grant execute on function public.ve_directory_plan_population(jsonb, text[]) to service_role, postgres;
