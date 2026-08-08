-- Сбор по каталогу забирает всё, что нашлось, а не первые 50 000.
--
-- Потолок в 50 000 стоял с тех пор, когда сбор был медленным: `fill_job` шёл
-- обходом первичного ключа и отваливался по таймауту шлюза. Причины этого
-- разобраны и устранены (миграция 20260807_0004 плюс индексы и конфиг базы —
-- docs/incidents/2026-08-08-yandex-maps-index-migration-lock.md), и держать
-- искусственную отсечку больше незачем: оператор выбрал места и сферы, значит
-- ему нужны все организации, а не произвольные пятьдесят тысяч из них.
--
-- Теперь `p_limit is null` означает «без ограничения». Число по-прежнему
-- принимается и работает — им пользуется кабинет клиента, где объём списывается
-- с тарифа.
--
-- Что защищает от возврата старой болезни: большие сборы не выполняются в
-- HTTP-запросе. API считает, сколько найдётся, и если это больше
-- CATALOG_INLINE_LIMIT (app/src/lib/parsers/yandexMapsCatalog.ts), заводит
-- задачу в очередь — её доделает воркер, которому шлюз не указ.

create or replace function public.yandex_maps_catalog_fill_job(
  p_job_id uuid,
  p_cities text[] default null,
  p_categories text[] default null,
  p_countries text[] default null,
  p_limit integer default null
)
returns table (organizations integer, links integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  where_sql text := public.yandex_maps_catalog_build_conditions(p_cities, p_categories, p_countries);
  -- null — забрать всё. Положительное число — потолок (кабинет клиента).
  -- Ноль означает «ничего не собирать» и остаётся как был.
  limit_sql text := case when p_limit is null then '' else ' limit ' || greatest(p_limit, 0) end;
  inserted_organizations integer := 0;
  inserted_links integer := 0;
begin
  if p_job_id is null or p_limit = 0 then
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
    -- Без order by: сортировка уводила планировщик в обход первичного ключа
    -- с построчной проверкой условий вместо битмапа по индексам.
    || limit_sql
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

-- Предпросчёт: `p_cap is null` — считать точно, без потолка.
--
-- Потолок остаётся нужен, потому что предпросчёт уходит на каждое изменение
-- фильтра: точный счёт по выборке в полмиллиона организаций — это чтение
-- сотен тысяч страниц кучи, и на каждый клик так ходить нельзя. Значение
-- задаёт вызывающий (CATALOG_PREVIEW_CAP), здесь только снимается жёсткая
-- привязка к 20 000.
create or replace function public.yandex_maps_catalog_count(
  p_cities text[] default null,
  p_categories text[] default null,
  p_countries text[] default null,
  p_cap integer default null
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
       || case when p_cap is null then ') capped'
               else format(' limit %s) capped', greatest(p_cap, 1)) end
     into result;
  return result;
end;
$$;

grant execute on function public.yandex_maps_catalog_fill_job(uuid, text[], text[], text[], integer)
  to service_role;
grant execute on function public.yandex_maps_catalog_count(text[], text[], text[], integer)
  to service_role;
