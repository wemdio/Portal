-- Фоновый поиск НОВЫХ организаций для каталога Яндекс.Карт.
--
-- Задача не «освежать имеющееся», а «находить то, чего у нас нет». Узнать про
-- новую организацию можно только одним способом — сделать обычный поиск
-- «город + рубрика» и посмотреть выдачу. Ключевая экономия в том, что сбор
-- ссылок из выдачи дёшев: идентификатор организации виден прямо в ссылке,
-- поэтому карточку открываем ТОЛЬКО у тех, кого ещё нет в каталоге.
--
-- Обход идёт по очереди пар «место × рубрика», по кругу, с отметкой времени
-- последнего просмотра.

-- ── Пометки на самих организациях ────────────────────────────────────────

alter table public.yandex_maps_company_catalog
  add column if not exists last_seen_in_search_at timestamptz,
  -- Сколько раз подряд организация не встретилась в исчерпывающей выдаче по
  -- своему городу и рубрике. Один промах ничего не значит — Яндекс мог просто
  -- иначе отранжировать; закрытие подозреваем после нескольких подряд.
  add column if not exists missing_streak integer not null default 0,
  add column if not exists closed_suspected_at timestamptz;

create index if not exists idx_ymc_closed_suspected
  on public.yandex_maps_company_catalog (closed_suspected_at)
  where closed_suspected_at is not null;

-- ── Доля организаций с контактами по рубрике ─────────────────────────────
-- Нужна, чтобы обход не тратил запросы к Яндексу на объекты карты: у скамейки
-- и детской площадки нет ни телефона, ни сайта, и для аутрича они бесполезны,
-- хотя по количеству records они в самом верху справочника.

alter table public.yandex_maps_catalog_rubrics
  add column if not exists with_contacts bigint not null default 0;

-- Пересчёт справочников переопределяется целиком: к нему добавился подсчёт
-- организаций с контактами по каждой рубрике.
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
      select btrim(token) as rubric,
             (c.phone <> '' or c.mobile_phone <> '' or c.all_phones <> ''
              or c.website <> '' or c.email <> '') as has_contact
        from public.yandex_maps_company_catalog c,
             lateral unnest(string_to_array(replace(c.categories, ' | ', ' / '), ' / ')) as token
       where c.categories <> ''
      union all
      select btrim(token),
             (c.phone <> '' or c.mobile_phone <> '' or c.all_phones <> ''
              or c.website <> '' or c.email <> '')
        from public.yandex_maps_company_catalog c,
             lateral unnest(string_to_array(c.subcategories, ', ')) as token
       where c.subcategories <> ''
    )
    select rubric,
           count(*)::bigint as companies,
           count(*) filter (where has_contact)::bigint as with_contacts
      from tokens
     where rubric <> ''
     group by 1
    having count(*) >= greatest(p_min_companies, 1);

  delete from public.yandex_maps_catalog_rubrics;
  insert into public.yandex_maps_catalog_rubrics (rubric, companies, with_contacts)
    select rubric, companies, with_contacts from tmp_rubrics;

  -- Часть значений в источнике — склеенные через запятую перечисления
  -- («Кафе, Отдых и туризм»). Убираем такой пункт, если его первая часть уже
  -- есть отдельно и встречается чаще: она найдёт те же строки, потому что
  -- фильтр ищет подстрокой.
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

-- ── Очередь обхода ───────────────────────────────────────────────────────

create table if not exists public.yandex_maps_catalog_discovery_queue (
  id bigint generated always as identity primary key,
  country text not null,
  -- Город, а если организации привязаны только к региону — регион.
  place text not null,
  rubric text not null,
  -- Ожидаемая отдача: размер места × размер рубрики с поправкой на контакты.
  priority bigint not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'failed')),
  next_scan_at timestamptz not null default now(),
  -- Когда задание взято в работу. Нужна отдельно от next_scan_at: та при
  -- взятии уезжает на неделю вперёд, и по ней зависшее задание не отличить.
  claimed_at timestamptz,
  last_scanned_at timestamptz,
  scans integer not null default 0,
  -- Сколько ссылок вернул Яндекс и сколько из них оказались новыми.
  last_seen_links integer,
  last_found_new integer,
  total_found_new bigint not null default 0,
  -- Выдача не упёрлась в лимит, значит по этому запросу мы видели всё.
  last_scan_exhaustive boolean not null default false,
  last_error text,
  unique (country, place, rubric)
);

create index if not exists idx_ymc_discovery_queue_next
  on public.yandex_maps_catalog_discovery_queue (next_scan_at, priority desc)
  where status in ('pending', 'failed');

-- ── Заполнение очереди из справочников ───────────────────────────────────

create or replace function public.yandex_maps_catalog_seed_discovery_queue(
  p_places integer default 200,
  p_rubrics integer default 100
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  added bigint;
begin
  with top_places as (
    select country, coalesce(nullif(city, ''), region) as place, sum(companies) as companies
      from public.yandex_maps_catalog_places
     where coalesce(nullif(city, ''), region) <> ''
     group by 1, 2
     order by 3 desc
     limit greatest(p_places, 1)
  ),
  top_rubrics as (
    select rubric,
           companies,
           -- Рубрики без контактов (скамейки, площадки, мусорные площадки)
           -- уезжают вниз и в выборку топа не попадают.
           (companies * greatest(with_contacts, 1)::numeric / greatest(companies, 1)) as weight
      from public.yandex_maps_catalog_rubrics
     order by weight desc
     limit greatest(p_rubrics, 1)
  )
  insert into public.yandex_maps_catalog_discovery_queue (country, place, rubric, priority)
  select p.country, p.place, r.rubric,
         (p.companies * r.weight / 1000)::bigint
    from top_places p
    cross join top_rubrics r
  on conflict (country, place, rubric) do nothing;

  get diagnostics added = row_count;
  return added;
end;
$$;

-- ── Выдача заданий воркеру ───────────────────────────────────────────────

create or replace function public.yandex_maps_catalog_claim_discovery(
  p_limit integer default 1,
  p_daily_limit integer default 15000
)
returns table (
  id bigint,
  country text,
  place text,
  rubric text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  allowance integer;
begin
  -- Дневной бюджет общий с прочими обращениями к Яндексу.
  allowance := public.yandex_maps_catalog_reserve_daily_budget(
    least(greatest(p_limit, 0), 100), greatest(p_daily_limit, 0)
  );
  if allowance <= 0 then
    return;
  end if;

  return query
  with picked as (
    select q.id
      from public.yandex_maps_catalog_discovery_queue q
     where q.status in ('pending', 'failed')
       and q.next_scan_at <= now()
     order by q.priority desc, q.next_scan_at
     for update skip locked
     limit allowance
  )
  update public.yandex_maps_catalog_discovery_queue q
     set status = 'running',
         claimed_at = now(),
         -- Отодвигаем сразу: падение воркера не должно оставлять задание
         -- вечно занятым и не должно крутить его по кругу без паузы.
         next_scan_at = now() + interval '7 days',
         last_error = null
    from picked
   where q.id = picked.id
  returning q.id, q.country, q.place, q.rubric;
end;
$$;

create or replace function public.yandex_maps_catalog_finish_discovery(
  p_id bigint,
  p_seen_links integer,
  p_found_new integer,
  p_exhaustive boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.yandex_maps_catalog_discovery_queue
     set status = case when p_error is null then 'pending' else 'failed' end,
         last_scanned_at = now(),
         scans = scans + 1,
         last_seen_links = p_seen_links,
         last_found_new = p_found_new,
         total_found_new = total_found_new + greatest(coalesce(p_found_new, 0), 0),
         last_scan_exhaustive = coalesce(p_exhaustive, false),
         last_error = p_error,
         -- Где находится новое — возвращаемся чаще; где пусто — реже.
         next_scan_at = now() + case
           when p_error is not null then interval '1 day'
           when coalesce(p_found_new, 0) > 0 then interval '14 days'
           else interval '60 days'
         end
   where id = p_id;
end;
$$;

-- ── Отметки «видели» и «возможно закрылась» ──────────────────────────────

-- Вызывается после обхода: p_seen — идентификаторы из выдачи Яндекса.
-- Пометку о возможном закрытии ставим только если выдача была исчерпывающей,
-- иначе отсутствие в списке ничего не доказывает.
create or replace function public.yandex_maps_catalog_mark_seen(
  p_seen text[],
  p_country text,
  p_place text,
  p_rubric text,
  p_exhaustive boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  suspected integer := 0;
begin
  if p_seen is not null and cardinality(p_seen) > 0 then
    update public.yandex_maps_company_catalog
       set last_seen_in_search_at = now(),
           missing_streak = 0,
           closed_suspected_at = null
     where yandex_id = any(p_seen);
  end if;

  if not coalesce(p_exhaustive, false) then
    return 0;
  end if;

  with candidates as (
    select c.yandex_id
      from public.yandex_maps_company_catalog c
     where c.country = p_country
       and (c.city = p_place or c.region = p_place)
       and (lower(c.categories) like '%' || lower(p_rubric) || '%'
            or lower(c.subcategories) like '%' || lower(p_rubric) || '%')
       and not (c.yandex_id = any(coalesce(p_seen, array[]::text[])))
  )
  update public.yandex_maps_company_catalog c
     set missing_streak = c.missing_streak + 1,
         closed_suspected_at = case
           when c.missing_streak + 1 >= 2 then now()
           else c.closed_suspected_at
         end
    from candidates
   where c.yandex_id = candidates.yandex_id;

  get diagnostics suspected = row_count;
  return suspected;
end;
$$;

-- Какие из присланных идентификаторов уже есть в каталоге. Воркер вычитает
-- их из выдачи и открывает карточки только у остальных.
create or replace function public.yandex_maps_catalog_known_ids(p_ids text[])
returns setof text
language sql
security definer
stable
set search_path = public
as $$
  select c.yandex_id
    from public.yandex_maps_company_catalog c
   where c.yandex_id = any(coalesce(p_ids, array[]::text[]));
$$;

grant execute on function public.yandex_maps_catalog_seed_discovery_queue(integer, integer) to service_role;
grant execute on function public.yandex_maps_catalog_claim_discovery(integer, integer) to service_role;
grant execute on function public.yandex_maps_catalog_finish_discovery(bigint, integer, integer, boolean, text) to service_role;
grant execute on function public.yandex_maps_catalog_mark_seen(text[], text, text, text, boolean) to service_role;
grant execute on function public.yandex_maps_catalog_known_ids(text[]) to service_role;
grant all on public.yandex_maps_catalog_discovery_queue to service_role;

alter table public.yandex_maps_catalog_discovery_queue enable row level security;

drop policy if exists yandex_maps_catalog_discovery_service_only
  on public.yandex_maps_catalog_discovery_queue;
create policy yandex_maps_catalog_discovery_service_only
  on public.yandex_maps_catalog_discovery_queue for all to service_role
  using (true) with check (true);
