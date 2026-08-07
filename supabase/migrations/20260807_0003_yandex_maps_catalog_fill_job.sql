-- Выдача каталога сразу в результаты запуска, одним запросом внутри базы.
--
-- Раньше выбор города и рубрики создавал задачу в очереди: воркер просыпался,
-- читал каталог страницами по 2000 строк через PostgREST и теми же страницами
-- писал их обратно в yandex_maps_organizations. Данные ради этого дважды
-- пересекали сеть, а человек ждал воркера — при том что искать нечего, всё уже
-- лежит в соседней таблице той же базы.
--
-- Здесь тот же отбор делается одним `insert ... select`: строки не покидают
-- Postgres, запуск отрабатывает в запросе API и сразу возвращает готовое.
--
-- Условия собираются той же yandex_maps_catalog_build_conditions, что и поиск
-- со счётчиком, — чтобы «сколько найдётся» и «сколько собралось» не разъезжались
-- и чтобы отбор шёл по индексам (см. комментарий в 20260807_0001).

create or replace function public.yandex_maps_catalog_fill_job(
  p_job_id uuid,
  p_cities text[] default null,
  p_categories text[] default null,
  p_countries text[] default null,
  p_limit integer default 50000
)
returns table (organizations integer, links integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  where_sql text := public.yandex_maps_catalog_build_conditions(p_cities, p_categories, p_countries);
  -- Тот же потолок, что у поиска: CATALOG_MAX_RESULTS в app/src/lib/parsers.
  capped integer := least(greatest(coalesce(p_limit, 50000), 0), 50000);
  inserted_organizations integer := 0;
  inserted_links integer := 0;
begin
  if p_job_id is null or capped = 0 then
    return query select 0, 0;
    return;
  end if;

  -- Пустой набор условий означал бы «весь каталог» — 9,9 млн строк в результаты
  -- одного запуска. Это не запрос, а промах вызывающего.
  if where_sql = '' then
    raise exception 'yandex_maps_catalog_fill_job: пустые условия отбора';
  end if;

  -- Поля повторяют catalogRowToOrganization в app/src/lib/parsers/yandexMapsCatalog.ts:
  -- телефон берётся первым непустым, ссылка на карточку при пустом card_url
  -- собирается из ID (Яндекс открывает организацию по одному идентификатору).
  execute
    $sql$
    insert into public.yandex_maps_organizations (
      job_id, name, country, city, address, rating, reviews_count, website, email,
      phone, telegram, vk, instagram, whatsapp, card_url, working_hours, categories
    )
    select $1,
           c.name, c.country, c.city, c.address, c.rating, c.reviews_count, c.website, c.email,
           coalesce(nullif(btrim(c.all_phones), ''), nullif(btrim(c.phone), ''), btrim(c.mobile_phone)),
           c.telegram, c.vkontakte, c.instagram, c.whatsapp,
           coalesce(nullif(btrim(c.card_url), ''), 'https://yandex.ru/maps/org/' || c.yandex_id),
           c.working_hours,
           array_to_string(
             array_remove(array[nullif(btrim(c.categories), ''), nullif(btrim(c.subcategories), '')], null),
             ' | '
           )
      from public.yandex_maps_company_catalog c
    $sql$
    || where_sql
    -- Порядок по первичному ключу: он же у поиска, поэтому «первые N» — один и
    -- тот же набор при повторе запуска.
    || ' order by c.yandex_id limit ' || capped
    -- Одна и та же карточка может встретиться в каталоге дважды (разные ID,
    -- одна ссылка) — берём первую и идём дальше.
    || ' on conflict (job_id, card_url) do nothing'
    using p_job_id;
  get diagnostics inserted_organizations = row_count;

  -- Ссылки — производная от уже записанных организаций, второй раз каталог
  -- перебирать незачем.
  insert into public.yandex_maps_links (job_id, link)
  select o.job_id, o.card_url
    from public.yandex_maps_organizations o
   where o.job_id = p_job_id
     and coalesce(o.card_url, '') <> ''
  on conflict (job_id, link) do nothing;
  get diagnostics inserted_links = row_count;

  return query select inserted_organizations, inserted_links;
end;
$fn$;

grant execute on function public.yandex_maps_catalog_fill_job(uuid, text[], text[], text[], integer)
  to service_role;
