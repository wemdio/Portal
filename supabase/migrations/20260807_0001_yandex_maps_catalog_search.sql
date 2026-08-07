-- Поиск по внутреннему каталогу Яндекс.Карт вместо живых запросов в Яндекс.
--
-- Тут три вещи:
--   1) индексы под фильтры (без них фильтр по городу — полный перебор 8 млн строк);
--   2) справочники мест и рубрик, из которых строится UI (чтобы на экране
--      нельзя было выбрать то, чего в базе нет);
--   3) поиск, который понимает города-регионы (Баку, Москва) и точные рубрики.
--
-- ВНИМАНИЕ: построение индексов на полном каталоге занимает минуты и держит
-- блокировку записи. Применять, когда снапшот-импорт не идёт.

-- ── 1. Индексы под фильтры ───────────────────────────────────────────────

create index if not exists idx_ymc_city
  on public.yandex_maps_company_catalog (city) where city <> '';
create index if not exists idx_ymc_region
  on public.yandex_maps_company_catalog (region) where region <> '';
create index if not exists idx_ymc_country
  on public.yandex_maps_company_catalog (country) where country <> '';

-- Рубрика ищется подстрокой по обоим полям; для categories триграммный индекс
-- уже есть (idx_yandex_maps_catalog_category_trgm), для subcategories не было.
create index if not exists idx_ymc_subcategories_trgm
  on public.yandex_maps_company_catalog using gin (lower(subcategories) gin_trgm_ops);

-- ── 2. Справочники для UI ────────────────────────────────────────────────

-- Страна → регион → город. Город может быть пустым: в выгрузках Яндекса
-- часть организаций привязана только к региону (Баку, сводные листы регионов).
create table if not exists public.yandex_maps_catalog_places (
  country text not null,
  region text not null,
  city text not null,
  companies bigint not null default 0,
  primary key (country, region, city)
);

create index if not exists idx_ymc_places_country
  on public.yandex_maps_catalog_places (country, companies desc);

-- Плоский список рубрик с числом организаций. Строится разбором обоих
-- форматов, которые встречаются в источнике:
--   xlsx «Рубрика»    — иерархия через « / »
--   csv  «Категории»  — перечисление через « | »
--   xlsx «Подрубрика» — перечисление через «, »
create table if not exists public.yandex_maps_catalog_rubrics (
  rubric text primary key,
  companies bigint not null default 0
);

create index if not exists idx_ymc_rubrics_companies
  on public.yandex_maps_catalog_rubrics (companies desc);

-- Порог отсекает мусорные обрывки, которые появляются из-за того, что часть
-- названий рубрик сама содержит запятую («Автосервис, услуги»).
create or replace function public.yandex_maps_catalog_refresh_dictionaries(
  p_min_companies integer default 20
)
returns table (places bigint, rubrics bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  place_count bigint;
  rubric_count bigint;
begin
  create temp table tmp_places on commit drop as
    select country, region, city, count(*)::bigint as companies
      from public.yandex_maps_company_catalog
     where country <> ''
     group by 1, 2, 3;

  delete from public.yandex_maps_catalog_places;
  insert into public.yandex_maps_catalog_places (country, region, city, companies)
    select country, region, city, companies from tmp_places;
  get diagnostics place_count = row_count;

  create temp table tmp_rubrics on commit drop as
    with tokens as (
      select btrim(token) as rubric
        from public.yandex_maps_company_catalog c,
             lateral unnest(string_to_array(replace(c.categories, ' | ', ' / '), ' / ')) as token
       where c.categories <> ''
      union all
      select btrim(token)
        from public.yandex_maps_company_catalog c,
             lateral unnest(string_to_array(c.subcategories, ', ')) as token
       where c.subcategories <> ''
    )
    select rubric, count(*)::bigint as companies
      from tokens
     where rubric <> ''
     group by 1
    having count(*) >= greatest(p_min_companies, 1);

  delete from public.yandex_maps_catalog_rubrics;
  insert into public.yandex_maps_catalog_rubrics (rubric, companies)
    select rubric, companies from tmp_rubrics;

  -- Часть значений в источнике — склеенные через запятую перечисления
  -- («Кафе, Отдых и туризм»). Убираем такой пункт, если его первая часть уже
  -- есть отдельно и встречается чаще: она найдёт те же строки, потому что
  -- фильтр ищет подстрокой. Настоящие названия с запятой («Автосервис,
  -- услуги») остаются — у них нет более частого «Автосервис».
  delete from public.yandex_maps_catalog_rubrics r
   where r.rubric like '%, %'
     and exists (
       select 1 from public.yandex_maps_catalog_rubrics head
        where head.rubric = split_part(r.rubric, ', ', 1)
          and head.companies > r.companies
     );

  select count(*) into rubric_count from public.yandex_maps_catalog_rubrics;

  return query select place_count, rubric_count;
end;
$$;

-- ── 3. Поиск ─────────────────────────────────────────────────────────────

-- p_cities — это выбранные пользователем МЕСТА. Совпадение проверяется и по
-- городу, и по региону: в выгрузках Яндекса города федерального значения
-- (Баку, Москва) часть организаций держат на уровне региона с пустым городом,
-- и фильтр только по city терял бы их десятками тысяч.
-- Старая пятиаргументная версия из 20260806_0001 убирается явно: иначе
-- create or replace создаст перегрузку и вызов станет неоднозначным.
drop function if exists public.yandex_maps_catalog_search(text[], text[], text[], integer, integer);

/**
 * Условия собираются в текст и выполняются через execute — намеренно.
 *
 * Замер на боевых данных (9,9 млн строк): вариант с постоянным набором
 * условий вида «параметр пуст ИЛИ совпадает» шёл 11 с, а тот же запрос
 * с подставленными значениями — 1 с. Причина в том, что такая дизъюнкция
 * неиндексируема: база обязана проверить каждую строку, а подзапрос по
 * рубрикам вдобавок собирает шаблон поиска на лету и не даёт использовать
 * триграммный индекс. Собирая только заданные условия, получаем план,
 * который использует индексы по стране, городу, региону и рубрикам.
 *
 * Значения подставляются через format('%L'), поэтому кавычки в названии
 * рубрики экранируются и ищутся как обычный текст.
 */
create or replace function public.yandex_maps_catalog_build_conditions(
  p_cities text[],
  p_categories text[],
  p_countries text[]
)
returns text
language plpgsql
immutable
as $$
declare
  conds text[] := array[]::text[];
begin
  if p_countries is not null and cardinality(p_countries) > 0 then
    conds := conds || format('c.country = any(%L::text[])', p_countries);
  end if;
  -- Город и регион проверяются вместе: города федерального значения (Баку,
  -- Москва) часть организаций держат на уровне региона с пустым городом.
  if p_cities is not null and cardinality(p_cities) > 0 then
    conds := conds || format('(c.city = any(%L::text[]) or c.region = any(%L::text[]))',
                             p_cities, p_cities);
  end if;
  if p_categories is not null and cardinality(p_categories) > 0 then
    conds := conds || (
      select '(' || string_agg(
               format('lower(c.categories) like %L or lower(c.subcategories) like %L',
                      '%' || lower(cat) || '%', '%' || lower(cat) || '%'), ' or ') || ')'
        from unnest(p_categories) cat
       where btrim(cat) <> ''
    );
  end if;
  return case when cardinality(conds) > 0
              then ' where ' || array_to_string(conds, ' and ')
              else '' end;
end;
$$;

create or replace function public.yandex_maps_catalog_search(
  p_cities text[] default null,
  p_categories text[] default null,
  p_countries text[] default null,
  p_limit integer default 250,
  p_offset integer default 0,
  p_after text default null
)
returns setof public.yandex_maps_company_catalog
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  where_sql text := public.yandex_maps_catalog_build_conditions(p_cities, p_categories, p_countries);
begin
  -- Постраничное чтение курсором по ключу. С OFFSET база на 25-й странице
  -- заново отбирала и выбрасывала 48 тыс. строк; с p_after она сразу встаёт
  -- на нужное место по первичному ключу.
  if p_after is not null and btrim(p_after) <> '' then
    where_sql := where_sql || case when where_sql = '' then ' where ' else ' and ' end
              || format('c.yandex_id > %L', p_after);
  end if;

  return query execute
    'select c.* from public.yandex_maps_company_catalog c'
    || where_sql
    || format(' order by c.yandex_id limit %s offset %s',
              least(greatest(coalesce(p_limit, 250), 0), 50000),
              greatest(coalesce(p_offset, 0), 0));
end;
$$;

grant execute on function public.yandex_maps_catalog_build_conditions(text[], text[], text[])
  to service_role;
grant execute on function public.yandex_maps_catalog_search(text[], text[], text[], integer, integer, text)
  to service_role;

-- Сколько найдётся до запуска — чтобы пустой результат было видно заранее.
-- Считается с потолком: пользователю нужен порядок величины, а не точное
-- число, а добор до упора стоит секунд.
create or replace function public.yandex_maps_catalog_count(
  p_cities text[] default null,
  p_categories text[] default null,
  p_countries text[] default null,
  p_cap integer default 20000
)
returns bigint
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  where_sql text := public.yandex_maps_catalog_build_conditions(p_cities, p_categories, p_countries);
  result bigint;
begin
  execute 'select count(*)::bigint from (select 1 from public.yandex_maps_company_catalog c'
       || where_sql
       || format(' limit %s) capped', greatest(coalesce(p_cap, 20000), 1))
     into result;
  return result;
end;
$$;

grant execute on function public.yandex_maps_catalog_refresh_dictionaries(integer) to service_role;
grant execute on function public.yandex_maps_catalog_count(text[], text[], text[], integer) to service_role;
grant all on public.yandex_maps_catalog_places to service_role;
grant all on public.yandex_maps_catalog_rubrics to service_role;

alter table public.yandex_maps_catalog_places enable row level security;
alter table public.yandex_maps_catalog_rubrics enable row level security;

-- Справочники читает сервер (service_role) и отдаёт в UI через API.
drop policy if exists yandex_maps_catalog_places_service_only on public.yandex_maps_catalog_places;
create policy yandex_maps_catalog_places_service_only
  on public.yandex_maps_catalog_places for all to service_role
  using (true) with check (true);

drop policy if exists yandex_maps_catalog_rubrics_service_only on public.yandex_maps_catalog_rubrics;
create policy yandex_maps_catalog_rubrics_service_only
  on public.yandex_maps_catalog_rubrics for all to service_role
  using (true) with check (true);
