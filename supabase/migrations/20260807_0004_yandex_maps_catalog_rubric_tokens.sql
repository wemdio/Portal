-- Рубрика ищется точным токеном, а не подстрокой. И отбор больше не сортируется.
--
-- Разбор проблемы целиком — docs/yandex-maps-catalog-search-performance.md.
-- Коротко, что было не так:
--
--   1. `lower(categories) like '%кафе%'` обслуживает триграммный GIN, а он не
--      селективен: по «кафе» поднимается 595 тыс. строк-кандидатов независимо от
--      того, сколько организаций останется после пересечения с городом. Битмап
--      нельзя построить наполовину, поэтому эту работу платит каждый запрос —
--      и тот, что вернёт 45 организаций, тоже. Отсюда «считает долго всегда».
--
--   2. `order by yandex_id limit N` в отборе — наследство курсорной пагинации.
--      Планировщик видел сортировку с лимитом, решал, что дешевле идти по
--      первичному ключу в нужном порядке, ВЫБРАСЫВАЛ битмап-индексы и построчно
--      проверял like, лазая в кучу за каждой строкой. На проде это случайные
--      чтения по таблице в 10+ ГБ с сетевого диска — то есть таймаут шлюза.
--
-- Токены те же, что считает yandex_maps_catalog_refresh_dictionaries: ' / ' для
-- «Рубрики» (после замены ' | ' из CSV-формата), ', ' для «Подрубрики». Поэтому
-- число рядом с рубрикой в форме и предпросчёт «сколько найдётся» теперь считают
-- одно и то же — раньше подстрока цепляла соседей («Кафе» находило «Антикафе»),
-- и цифры расходились.

-- ── Токены рубрик ────────────────────────────────────────────────────────

-- immutable обязателен: иначе по выражению нельзя построить индекс.
create or replace function public.yandex_maps_rubric_tokens(
  p_categories text,
  p_subcategories text
)
returns text[]
language sql
immutable
parallel safe
as $$
  select coalesce(array_agg(distinct token), '{}'::text[])
    from (
      select btrim(lower(t)) as token
        from unnest(string_to_array(replace(coalesce(p_categories, ''), ' | ', ' / '), ' / ')) t
      union all
      select btrim(lower(t))
        from unnest(string_to_array(coalesce(p_subcategories, ''), ', ')) t
    ) tokens
   where token <> ''
$$;

-- ── Индексы: строятся ОТДЕЛЬНО, до деплоя ────────────────────────────────

-- Нужны три индекса по выражению (по выражению, а не по новой колонке: колонка
-- потребовала бы переписать таблицу на 9,9 млн строк с удвоением её размера до
-- вакуума):
--
--   idx_ymc_rubric_tokens  — рубрика без места, выбор «вся страна × рубрика»;
--   idx_ymc_tokens_city    — рубрика × город;
--   idx_ymc_tokens_region  — рубрика × регион.
--
-- Составных два, а не один: место сверяется и с городом, и с регионом (города
-- федерального значения часть организаций держат на уровне региона с пустым
-- городом), и это «или» планировщик разбирает как BitmapOr двух сканов. Они и
-- дают основной выигрыш: обычный запрос формы — всегда «место × сфера», и по
-- ним он идёт ОДНИМ проходом вместо пересечения двух огромных битмапов. На
-- замере «Москва+МО+СПб × Кафе» кандидатов 63 тыс. вместо 2 млн, чтение кучи —
-- 6,7 тыс. блоков вместо 23 тыс.
--
-- ПОЧЕМУ ИХ ЗДЕСЬ НЕ СТРОЯТ. Обычный `create index` держит на таблице SHARE:
-- запись в неё запрещена на всё время постройки, а это минуты на 9,9 млн строк.
-- В каталог непрерывно пишет фоновый обход (`yandex_maps_catalog_discovery_queue`),
-- миграции идут в транзакции с `lock_timeout = 30s` — и 08.08.2026 деплой на
-- этом встал: `55P03 canceling statement due to lock timeout`, откат всей
-- миграции, прод остался на старой сборке. Повтор деплоя упёрся бы в то же
-- самое: обход работает всегда, окна без записи не бывает.
--
-- Поэтому индексы строятся заранее и отдельно, через `create index concurrently`
-- (запись не блокирует, идёт дольше):
--
--   docker run --rm --network host --env-file .env <образ portal> \
--     node scripts/db/buildYandexMapsRubricTokenIndexes.js
--
-- Скрипт идемпотентный: готовые индексы пропускает, недостроенные (после обрыва
-- concurrently остаётся invalid-индекс) сносит и строит заново.
create extension if not exists btree_gin;

-- Дальше — проверка, а не постройка.
--
-- Без этих индексов `tokens && array[...]` не индексируется ничем: и поиск, и
-- предпросчёт уходят в seq scan по 13 ГБ на каждое изменение фильтра. Это хуже,
-- чем было до миграции, поэтому пускать функции вперёд индексов нельзя —
-- миграция останавливается с внятным текстом вместо того, чтобы молча положить
-- форму.
--
-- На маленьком каталоге (локальная разработка, свежая база) ждать нечего:
-- постройка занимает секунды и блокировать некого — строим прямо здесь.
do $ymc$
declare
  missing text[];
  table_bytes bigint;
  rec record;
begin
  select coalesce(array_agg(want.index_name order by want.index_name), '{}'::text[])
    into missing
    from (values ('idx_ymc_rubric_tokens'), ('idx_ymc_tokens_city'), ('idx_ymc_tokens_region'))
           as want(index_name)
   where not exists (
           select 1
             from pg_index x
             join pg_class i on i.oid = x.indexrelid
            where i.relname = want.index_name
              and i.relnamespace = 'public'::regnamespace
              and x.indrelid = 'public.yandex_maps_company_catalog'::regclass
              -- indisvalid: обрыв concurrently оставляет индекс с тем же именем,
              -- которым планировщик не пользуется. Он не считается готовым.
              and x.indisvalid
         );

  if cardinality(missing) = 0 then
    return;
  end if;

  -- Порог по размеру, а не по reltuples: на свежей базе статистики ещё нет
  -- (reltuples = -1), и «строк мало» пришлось бы угадывать. Боевой каталог —
  -- 13 ГБ, любой стенд с осмысленным объёмом далеко под гигабайтом.
  table_bytes := pg_table_size('public.yandex_maps_company_catalog'::regclass);

  if table_bytes > 1073741824 then
    raise exception
      -- В RAISE «%» — единственный placeholder, формата у него нет: округляем сами.
      'yandex_maps_company_catalog (% ГБ): не построены индексы %. Построй их, не блокируя запись: docker run --rm --network host --env-file .env <образ portal> node scripts/db/buildYandexMapsRubricTokenIndexes.js — и повтори деплой. Подробности: docs/yandex-maps-catalog-search-performance.md',
      round(table_bytes / 1073741824.0, 1),
      array_to_string(missing, ', ')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  for rec in
    select *
      from (values
        ('idx_ymc_rubric_tokens', 'gin (public.yandex_maps_rubric_tokens(categories, subcategories))'),
        ('idx_ymc_tokens_city',   'gin (public.yandex_maps_rubric_tokens(categories, subcategories), city)'),
        ('idx_ymc_tokens_region', 'gin (public.yandex_maps_rubric_tokens(categories, subcategories), region)')
      ) as t(index_name, using_clause)
     where t.index_name = any(missing)
  loop
    -- Недостроенный индекс носит то же имя, и `if not exists` его бы пропустил,
    -- оставив каталог без рабочего индекса навсегда.
    execute format('drop index if exists public.%I', rec.index_name);
    execute format(
      'create index %I on public.yandex_maps_company_catalog using %s',
      rec.index_name, rec.using_clause);
  end loop;
end
$ymc$;

-- ── Условия отбора ───────────────────────────────────────────────────────

/**
 * Условия по-прежнему собираются текстом и выполняются через execute — причина
 * та же, что и была (см. 20260807_0001): постоянный набор условий вида
 * «параметр пуст ИЛИ совпадает» неиндексируем.
 *
 * Изменилось одно: рубрика проверяется пересечением массивов токенов вместо
 * пары like по двум колонкам. Значения экранируются через format('%L').
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
  tokens text[];
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
    -- В справочнике «Кафе» и «кафе» — два разных пункта, и выбирают их оба.
    -- После lower() это один токен: дубли схлопываем, чтобы не гонять по
    -- индексу одно и то же несколько раз.
    select array_agg(distinct btrim(lower(category)))
      into tokens
      from unnest(p_categories) category
     where btrim(category) <> '';
    if tokens is not null and cardinality(tokens) > 0 then
      conds := conds || format(
        'public.yandex_maps_rubric_tokens(c.categories, c.subcategories) && %L::text[]',
        tokens);
    end if;
  end if;
  return case when cardinality(conds) > 0
              then ' where ' || array_to_string(conds, ' and ')
              else '' end;
end;
$$;

-- ── Отбор без сортировки ─────────────────────────────────────────────────

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
    -- Без order by. Сортировка тут была наследством курсорной пагинации, а
    -- стоила плана: с ней планировщик уходил в обход первичного ключа с
    -- построчной проверкой условий вместо битмапа по индексам. Порядок «первых
    -- N» нам безразличен — берём любые N, подходящие под условия.
    || ' limit ' || capped
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

-- ── Фоновый обход — то же понимание «рубрика совпала» ────────────────────

-- Функция переопределяется целиком; изменилась одна строка — проверка рубрики.
-- Дело не только в скорости (запрос той же формы «место × рубрика», ему тоже
-- достаётся составной индекс): с подстрокой обход, просмотрев выдачу Яндекса по
-- «Кафе», помечал пропавшими ещё и интернет-кафе с антикафе, которых в этой
-- выдаче и не могло быть. Двух попаданий подряд хватало, чтобы записать живую
-- организацию в закрытые.
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
       and public.yandex_maps_rubric_tokens(c.categories, c.subcategories)
           && array[btrim(lower(p_rubric))]
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

grant execute on function public.yandex_maps_catalog_mark_seen(text[], text, text, text, boolean)
  to service_role;
grant execute on function public.yandex_maps_rubric_tokens(text, text) to service_role;
grant execute on function public.yandex_maps_catalog_build_conditions(text[], text[], text[])
  to service_role;
grant execute on function public.yandex_maps_catalog_fill_job(uuid, text[], text[], text[], integer)
  to service_role;
