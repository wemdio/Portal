-- Общий каталог организаций Яндекс.Карт.
--
-- В отличие от yandex_maps_organizations эта таблица не привязана к запуску
-- парсера: одна карточка = одна строка, уникальность обеспечивается
-- стабильным ID организации в Яндекс.Картах. Источники (CSV/XLSX и живой
-- парсер) могут присылать одну карточку много раз — upsert импортера и
-- воркера объединяет непустые поля и сохраняет происхождение записи.

create extension if not exists pg_trgm;

create table if not exists public.yandex_maps_company_catalog (
  yandex_id text primary key check (btrim(yandex_id) <> ''),

  name text not null default '',
  categories text not null default '',
  subcategories text not null default '',
  query text not null default '',
  country text not null default '',
  region text not null default '',
  district text not null default '',
  city text not null default '',
  address text not null default '',
  postal_code text not null default '',

  phone text not null default '',
  mobile_phone text not null default '',
  all_phones text not null default '',
  email text not null default '',
  website text not null default '',
  all_sites text not null default '',
  working_hours text not null default '',
  payment_methods text not null default '',
  attributes text not null default '',

  latitude text not null default '',
  longitude text not null default '',
  rating text not null default '',
  reviews_count text not null default '',
  network_id text not null default '',
  network_name text not null default '',

  telegram text not null default '',
  vkontakte text not null default '',
  odnoklassniki text not null default '',
  facebook text not null default '',
  instagram text not null default '',
  youtube text not null default '',
  twitter text not null default '',
  viber text not null default '',
  whatsapp text not null default '',
  fax text not null default '',
  rutube text not null default '',
  yandex_zen text not null default '',

  card_url text not null default '',
  booking_url text not null default '',
  order_url text not null default '',
  priority_placement text not null default '',
  logo text not null default '',
  source_extra jsonb not null default '{}'::jsonb,

  source_kinds text[] not null default '{}'::text[],
  source_files text[] not null default '{}'::text[],
  source_occurrences integer not null default 1 check (source_occurrences > 0),
  last_source_kind text not null default '',
  last_source_file text not null default '',
  last_source_row integer,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_refreshed_at timestamptz,
  next_refresh_at timestamptz not null default now(),
  refresh_status text not null default 'pending'
    check (refresh_status in ('pending', 'running', 'completed', 'failed')),
  refresh_attempts integer not null default 0 check (refresh_attempts >= 0),
  refresh_started_at timestamptz,
  last_refresh_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_yandex_maps_catalog_country_city_id
  on public.yandex_maps_company_catalog (country, city, yandex_id);
create index if not exists idx_yandex_maps_catalog_region_city_id
  on public.yandex_maps_company_catalog (region, city, yandex_id);
create index if not exists idx_yandex_maps_catalog_refresh_queue
  on public.yandex_maps_company_catalog (next_refresh_at, yandex_id)
  where refresh_status in ('pending', 'failed');
create index if not exists idx_yandex_maps_catalog_category_trgm
  on public.yandex_maps_company_catalog using gin (lower(categories) gin_trgm_ops);
create index if not exists idx_yandex_maps_catalog_name_trgm
  on public.yandex_maps_company_catalog using gin (lower(name) gin_trgm_ops);
create index if not exists idx_yandex_maps_catalog_website
  on public.yandex_maps_company_catalog (yandex_id)
  where website <> '';
create index if not exists idx_yandex_maps_catalog_email
  on public.yandex_maps_company_catalog (yandex_id)
  where email <> '';

create table if not exists public.yandex_maps_catalog_import_runs (
  source_key text primary key,
  status text not null check (status in ('running', 'completed', 'failed')),
  source_files integer not null default 0,
  source_rows bigint not null default 0,
  accepted_rows bigint not null default 0,
  duplicate_rows bigint not null default 0,
  rejected_rows bigint not null default 0,
  unique_ids bigint not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.yandex_maps_catalog_refresh_daily (
  day date primary key default current_date,
  reserved_rows integer not null default 0 check (reserved_rows >= 0),
  completed_rows integer not null default 0 check (completed_rows >= 0),
  updated_at timestamptz not null default now()
);

create or replace function public.yandex_maps_catalog_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_yandex_maps_catalog_touch_updated_at
  on public.yandex_maps_company_catalog;
create trigger trg_yandex_maps_catalog_touch_updated_at
before update on public.yandex_maps_company_catalog
for each row execute function public.yandex_maps_catalog_touch_updated_at();

-- Бронь дневного бюджета нужна, чтобы несколько инстансов воркера не
-- превышали лимит обращений к Яндекс.Картам. Функция атомарна.
create or replace function public.yandex_maps_catalog_reserve_daily_budget(
  p_requested integer,
  p_daily_limit integer default 15000
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  before_reserved integer;
  after_reserved integer;
begin
  if p_requested <= 0 or p_daily_limit <= 0 then
    return 0;
  end if;

  insert into public.yandex_maps_catalog_refresh_daily(day)
  values (current_date)
  on conflict (day) do nothing;

  select d.reserved_rows
    into before_reserved
    from public.yandex_maps_catalog_refresh_daily d
   where d.day = current_date
   for update;

  after_reserved := before_reserved
                    + least(p_requested, greatest(p_daily_limit - before_reserved, 0));

  update public.yandex_maps_catalog_refresh_daily
     set reserved_rows = after_reserved,
         updated_at = now()
   where day = current_date;

  return greatest(after_reserved - before_reserved, 0);
end;
$$;

-- Upsert для живого парсера. Вход — массив частичных JSON-объектов: пустые
-- поля не затирают более полную запись из snapshot-импорта.
create or replace function public.yandex_maps_catalog_upsert_rows(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  with incoming as (
    select *
      from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
        yandex_id text, name text, categories text, subcategories text,
        query text, country text, region text, district text, city text,
        address text, postal_code text, phone text, mobile_phone text,
        all_phones text, email text, website text, all_sites text,
        working_hours text, payment_methods text, attributes text,
        latitude text, longitude text, rating text, reviews_count text,
        network_id text, network_name text, telegram text, vkontakte text,
        odnoklassniki text, facebook text, instagram text, youtube text,
        twitter text, viber text, whatsapp text, fax text, rutube text,
        yandex_zen text, card_url text, booking_url text, order_url text,
        priority_placement text, logo text, source_extra jsonb,
        source_kind text, source_file text, source_row integer
      )
     where btrim(coalesce(x.yandex_id, '')) <> ''
  )
  insert into public.yandex_maps_company_catalog as c (
    yandex_id, name, categories, subcategories, query, country, region,
    district, city, address, postal_code, phone, mobile_phone, all_phones,
    email, website, all_sites, working_hours, payment_methods, attributes,
    latitude, longitude, rating, reviews_count, network_id, network_name,
    telegram, vkontakte, odnoklassniki, facebook, instagram, youtube,
    twitter, viber, whatsapp, fax, rutube, yandex_zen, card_url,
    booking_url, order_url, priority_placement, logo, source_extra,
    source_kinds, source_files, source_occurrences, last_source_kind,
    last_source_file, last_source_row
  )
  select i.yandex_id,
    coalesce(i.name, ''), coalesce(i.categories, ''), coalesce(i.subcategories, ''),
    coalesce(i.query, ''), coalesce(i.country, ''), coalesce(i.region, ''),
    coalesce(i.district, ''), coalesce(i.city, ''), coalesce(i.address, ''),
    coalesce(i.postal_code, ''), coalesce(i.phone, ''), coalesce(i.mobile_phone, ''),
    coalesce(i.all_phones, ''), coalesce(i.email, ''), coalesce(i.website, ''),
    coalesce(i.all_sites, ''), coalesce(i.working_hours, ''), coalesce(i.payment_methods, ''),
    coalesce(i.attributes, ''), coalesce(i.latitude, ''), coalesce(i.longitude, ''),
    coalesce(i.rating, ''), coalesce(i.reviews_count, ''), coalesce(i.network_id, ''),
    coalesce(i.network_name, ''), coalesce(i.telegram, ''), coalesce(i.vkontakte, ''),
    coalesce(i.odnoklassniki, ''), coalesce(i.facebook, ''), coalesce(i.instagram, ''),
    coalesce(i.youtube, ''), coalesce(i.twitter, ''), coalesce(i.viber, ''),
    coalesce(i.whatsapp, ''), coalesce(i.fax, ''), coalesce(i.rutube, ''),
    coalesce(i.yandex_zen, ''), coalesce(i.card_url, ''), coalesce(i.booking_url, ''),
    coalesce(i.order_url, ''), coalesce(i.priority_placement, ''), coalesce(i.logo, ''),
    coalesce(i.source_extra, '{}'::jsonb),
    array[coalesce(nullif(i.source_kind, ''), 'parser')],
    array[coalesce(nullif(i.source_file, ''), 'live_parser')],
    1, coalesce(nullif(i.source_kind, ''), 'parser'),
    coalesce(nullif(i.source_file, ''), 'live_parser'), i.source_row
  from incoming i
  on conflict (yandex_id) do update set
    name = case when excluded.name <> '' then excluded.name else c.name end,
    categories = case when excluded.categories <> '' then excluded.categories else c.categories end,
    subcategories = case when excluded.subcategories <> '' then excluded.subcategories else c.subcategories end,
    query = case when excluded.query <> '' then excluded.query else c.query end,
    country = case when excluded.country <> '' then excluded.country else c.country end,
    region = case when excluded.region <> '' then excluded.region else c.region end,
    district = case when excluded.district <> '' then excluded.district else c.district end,
    city = case when excluded.city <> '' then excluded.city else c.city end,
    address = case when excluded.address <> '' then excluded.address else c.address end,
    postal_code = case when excluded.postal_code <> '' then excluded.postal_code else c.postal_code end,
    phone = case when excluded.phone <> '' then excluded.phone else c.phone end,
    mobile_phone = case when excluded.mobile_phone <> '' then excluded.mobile_phone else c.mobile_phone end,
    all_phones = case when excluded.all_phones <> '' then excluded.all_phones else c.all_phones end,
    email = case when excluded.email <> '' then excluded.email else c.email end,
    website = case when excluded.website <> '' then excluded.website else c.website end,
    all_sites = case when excluded.all_sites <> '' then excluded.all_sites else c.all_sites end,
    working_hours = case when excluded.working_hours <> '' then excluded.working_hours else c.working_hours end,
    payment_methods = case when excluded.payment_methods <> '' then excluded.payment_methods else c.payment_methods end,
    attributes = case when excluded.attributes <> '' then excluded.attributes else c.attributes end,
    latitude = case when excluded.latitude <> '' then excluded.latitude else c.latitude end,
    longitude = case when excluded.longitude <> '' then excluded.longitude else c.longitude end,
    rating = case when excluded.rating <> '' then excluded.rating else c.rating end,
    reviews_count = case when excluded.reviews_count <> '' then excluded.reviews_count else c.reviews_count end,
    network_id = case when excluded.network_id <> '' then excluded.network_id else c.network_id end,
    network_name = case when excluded.network_name <> '' then excluded.network_name else c.network_name end,
    telegram = case when excluded.telegram <> '' then excluded.telegram else c.telegram end,
    vkontakte = case when excluded.vkontakte <> '' then excluded.vkontakte else c.vkontakte end,
    odnoklassniki = case when excluded.odnoklassniki <> '' then excluded.odnoklassniki else c.odnoklassniki end,
    facebook = case when excluded.facebook <> '' then excluded.facebook else c.facebook end,
    instagram = case when excluded.instagram <> '' then excluded.instagram else c.instagram end,
    youtube = case when excluded.youtube <> '' then excluded.youtube else c.youtube end,
    twitter = case when excluded.twitter <> '' then excluded.twitter else c.twitter end,
    viber = case when excluded.viber <> '' then excluded.viber else c.viber end,
    whatsapp = case when excluded.whatsapp <> '' then excluded.whatsapp else c.whatsapp end,
    fax = case when excluded.fax <> '' then excluded.fax else c.fax end,
    rutube = case when excluded.rutube <> '' then excluded.rutube else c.rutube end,
    yandex_zen = case when excluded.yandex_zen <> '' then excluded.yandex_zen else c.yandex_zen end,
    card_url = case when excluded.card_url <> '' then excluded.card_url else c.card_url end,
    booking_url = case when excluded.booking_url <> '' then excluded.booking_url else c.booking_url end,
    order_url = case when excluded.order_url <> '' then excluded.order_url else c.order_url end,
    priority_placement = case when excluded.priority_placement <> '' then excluded.priority_placement else c.priority_placement end,
    logo = case when excluded.logo <> '' then excluded.logo else c.logo end,
    source_extra = c.source_extra || excluded.source_extra,
    source_kinds = (select array_agg(distinct value) from unnest(c.source_kinds || excluded.source_kinds) value),
    source_files = (select array_agg(distinct value) from unnest(c.source_files || excluded.source_files) value),
    source_occurrences = c.source_occurrences + excluded.source_occurrences,
    last_source_kind = excluded.last_source_kind,
    last_source_file = excluded.last_source_file,
    last_source_row = excluded.last_source_row,
    last_seen_at = now();

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Воркеры берут строки с блокировкой SKIP LOCKED. После брони строка
-- получает новое next_refresh_at, поэтому падение процесса не создаёт
-- бесконечный цикл запросов.
create or replace function public.yandex_maps_catalog_claim_refresh_batch(
  p_limit integer default 250,
  p_daily_limit integer default 15000
)
returns table (
  yandex_id text,
  card_url text,
  name text,
  city text,
  categories text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  take_count integer;
begin
  take_count := public.yandex_maps_catalog_reserve_daily_budget(
    least(greatest(p_limit, 0), 5000), greatest(p_daily_limit, 0)
  );
  if take_count <= 0 then
    return;
  end if;

  return query
  with picked as (
    select c.yandex_id
      from public.yandex_maps_company_catalog c
     where c.refresh_status in ('pending', 'failed')
       and c.next_refresh_at <= now()
       and c.card_url <> ''
     order by c.next_refresh_at, c.yandex_id
     for update skip locked
     limit take_count
  )
  update public.yandex_maps_company_catalog c
     set refresh_status = 'running',
         refresh_attempts = c.refresh_attempts + 1,
         refresh_started_at = now(),
         next_refresh_at = now() + interval '1 day',
         last_refresh_error = null
    from picked
   where c.yandex_id = picked.yandex_id
  returning c.yandex_id, c.card_url, c.name, c.city, c.categories;
end;
$$;

create or replace function public.yandex_maps_catalog_record_completed(
  p_completed integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_completed <= 0 then
    return;
  end if;

  insert into public.yandex_maps_catalog_refresh_daily(day, completed_rows)
  values (current_date, p_completed)
  on conflict (day) do update
    set completed_rows = public.yandex_maps_catalog_refresh_daily.completed_rows + excluded.completed_rows,
        updated_at = now();
end;
$$;

create or replace function public.yandex_maps_catalog_search(
  p_cities text[] default null,
  p_categories text[] default null,
  p_countries text[] default null,
  p_limit integer default 250,
  p_offset integer default 0
)
returns setof public.yandex_maps_company_catalog
language sql
security definer
stable
set search_path = public
as $$
  select c.*
    from public.yandex_maps_company_catalog c
   where (p_cities is null or cardinality(p_cities) = 0 or c.city = any(p_cities))
     and (p_countries is null or cardinality(p_countries) = 0 or c.country = any(p_countries))
     and (
       p_categories is null or cardinality(p_categories) = 0
       or exists (
         select 1
           from unnest(p_categories) category
          where lower(c.categories) like '%' || lower(category) || '%'
             or lower(c.subcategories) like '%' || lower(category) || '%'
       )
     )
   order by c.yandex_id
   limit least(greatest(coalesce(p_limit, 250), 0), 5000)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

grant execute on function public.yandex_maps_catalog_search(text[], text[], text[], integer, integer)
  to service_role;
grant execute on function public.yandex_maps_catalog_reserve_daily_budget(integer, integer)
  to service_role;
grant execute on function public.yandex_maps_catalog_claim_refresh_batch(integer, integer)
  to service_role;
grant execute on function public.yandex_maps_catalog_record_completed(integer)
  to service_role;
grant execute on function public.yandex_maps_catalog_upsert_rows(jsonb)
  to service_role;
grant all on public.yandex_maps_company_catalog to service_role;
grant all on public.yandex_maps_catalog_import_runs to service_role;
grant all on public.yandex_maps_catalog_refresh_daily to service_role;

alter table public.yandex_maps_company_catalog enable row level security;
alter table public.yandex_maps_catalog_import_runs enable row level security;
alter table public.yandex_maps_catalog_refresh_daily enable row level security;

-- Каталог читается только server-side service_role. Пользователь получает
-- результаты собственного запуска через yandex_maps_organizations.
drop policy if exists yandex_maps_catalog_service_only on public.yandex_maps_company_catalog;
create policy yandex_maps_catalog_service_only
  on public.yandex_maps_company_catalog for all to service_role
  using (true) with check (true);

drop policy if exists yandex_maps_catalog_import_runs_service_only on public.yandex_maps_catalog_import_runs;
create policy yandex_maps_catalog_import_runs_service_only
  on public.yandex_maps_catalog_import_runs for all to service_role
  using (true) with check (true);

drop policy if exists yandex_maps_catalog_daily_service_only on public.yandex_maps_catalog_refresh_daily;
create policy yandex_maps_catalog_daily_service_only
  on public.yandex_maps_catalog_refresh_daily for all to service_role
  using (true) with check (true);
