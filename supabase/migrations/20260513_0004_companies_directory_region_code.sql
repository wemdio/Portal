-- Добавляем колонку region_code для моментальной фильтрации по регионам.
-- Вместо ILIKE '%token%' по address (full scan) — exact match по region_code (btree index).
set statement_timeout = '600s';

alter table public.companies_directory
  add column if not exists region_code text;

-- Справочник token→code для backfill
create temporary table _region_tokens (token text, code text);
insert into _region_tokens (token, code) values
  ('Белгородск','31'),('Брянск','32'),('Владимирск','33'),('Воронежск','36'),
  ('Ивановск','37'),('Калужск','40'),('Костромск','44'),('Курск','46'),
  ('Липецк','48'),('Московск','50'),('Орловск','57'),('Рязанск','62'),
  ('Смоленск','67'),('Тамбовск','68'),('Тверск','69'),('Тульск','71'),
  ('Ярославск','76'),('г. Москва','77'),('г.Москва','77'),('Москва','77'),
  ('Карелия','10'),('Коми','11'),('Архангельск','29'),('Вологодск','35'),
  ('Калининградск','39'),('Ленинградск','47'),('Мурманск','51'),('Новгородск','53'),
  ('Псковск','60'),('Санкт-Петербург','78'),('СПб','78'),('Ненецк','83'),
  ('Адыгея','01'),('Калмыки','08'),('Краснодарск','23'),('Астрахан','30'),
  ('Волгоградск','34'),('Ростовск','61'),('Крым','82'),('Севастополь','92'),
  ('Дагестан','05'),('Ингушети','06'),('Кабардино','07'),('Карачаево','09'),
  ('Осети','15'),('Чеченск','20'),('Ставропольск','26'),
  ('Башкортостан','02'),('Башкири','02'),('Марий','12'),('Мордови','13'),
  ('Татарстан','16'),('Удмурт','18'),('Чуваш','21'),('Кировск','43'),
  ('Нижегородск','52'),('Оренбургск','56'),('Пензенск','58'),('Пермск','59'),
  ('Самарск','63'),('Саратовск','64'),('Ульяновск','73'),
  ('Курганск','45'),('Свердловск','66'),('Тюменск','72'),('Челябинск','74'),
  ('Ханты-Мансийск','86'),('Югра','86'),('Ямало-Ненец','89'),
  ('Буряти','03'),('Тыва','17'),('Тува','17'),('Хакаси','19'),
  ('Алтай','04'),('Алтайск','22'),('Красноярск','24'),('Иркутск','38'),
  ('Кемеровск','42'),('Кузбасс','42'),('Новосибирск','54'),('Омск','55'),('Томск','70'),
  ('Якути','14'),('Саха','14'),('Приморск','25'),('Хабаровск','27'),
  ('Амурск','28'),('Камчатск','41'),('Магаданск','49'),('Сахалинск','65'),
  ('Забайкальск','75'),('Еврейск','79'),('Чукотск','87'),
  ('Донецк','93'),('Луганск','94'),('Запорожск','90'),('Херсонск','95');

-- Backfill: первый совпавший токен (длинные токены проверяются первыми для точности)
update public.companies_directory c
set region_code = sub.code
from (
  select distinct on (c2.id) c2.id, rt.code
  from public.companies_directory c2
  join _region_tokens rt on c2.address ilike '%' || rt.token || '%'
  order by c2.id, length(rt.token) desc
) sub
where c.id = sub.id and c.region_code is null;

drop table _region_tokens;

create index if not exists companies_directory_region_code_idx
  on public.companies_directory (region_code);

-- ── Count (переписан на region_code) ─────────────────────────────────
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
  p_region_codes    text[]  default null
)
returns bigint
language sql stable
set statement_timeout = '180s'
as $$
  select count(*)
  from public.companies_directory c
  where
    (p_region_codes is null or c.region_code = any(p_region_codes))
    and (p_region_tokens is null or p_region_codes is not null
         or exists (select 1 from unnest(p_region_tokens) t where c.address ilike '%' || t || '%'))
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
$$;

-- ── Fetch rows (переписан на region_code) ────────────────────────────
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
  p_region_codes    text[]  default null
)
returns jsonb
language plpgsql stable
set statement_timeout = '180s'
as $$
begin
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

grant execute on function public.companies_directory_count_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], text[]
) to service_role, authenticated;

grant execute on function public.companies_directory_fetch_rpc(
  text[], text[], boolean, boolean, text[], boolean, boolean, boolean,
  boolean, numeric, numeric, numeric, numeric, int, int, text[], text[], int, int, text[]
) to service_role, authenticated;
