-- Сбор по каталогу больше не дублирует ссылки в yandex_maps_links.
--
-- `yandex_maps_links` нужна живому парсингу: там сначала собирают ссылки выдачи,
-- их можно поправить руками, и только потом по ним открывают карточки. У сбора
-- по каталогу этого этапа нет — организации приходят готовыми, а «ссылка» это
-- просто их же колонка card_url. Таблица получала точную копию одного поля
-- каждой строки и не отвечала ни на один вопрос, которого не отвечает сама
-- выдача.
--
-- Стоило это трети всего сбора. Замер на 100 000 организаций (локальный NVMe,
-- прогретый кэш):
--
--   поиск (найти 100 тыс. организаций)   0,48 с
--   вставка организаций                  3,17 с
--   вставка ссылок                       1,47 с   ← вот это
--   ---------------------------------------------
--   fill_job целиком                     4,25 с
--
-- Плюс 56 МБ на диске против 110 МБ у самих организаций. На боевом сборе в
-- сотни тысяч строк это минуты и гигабайты на копию одной колонки.
--
-- Живой парсинг не задет: он пишет ссылки сам (yandexMapsWorker.ts), эта
-- функция к нему отношения не имеет. `links` в ответе остаётся ради
-- совместимости сигнатуры и всегда 0 — вызывающие кладут его в total_links,
-- а в истории у собранных задач показывается число организаций, не ссылок.

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

  return query select inserted_organizations, 0;
end;
$fn$;

grant execute on function public.yandex_maps_catalog_fill_job(uuid, text[], text[], text[], integer)
  to service_role;
