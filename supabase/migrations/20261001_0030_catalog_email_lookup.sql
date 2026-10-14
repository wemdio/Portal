-- Почта компании из наших каталогов Яндекс Карт — второй источник адреса для
-- «Нашего автоаутрича» (RU).
--
-- Зачем: в запуске 01.10.2026 из 433 просмотренных компаний 131 отсеяна с
-- причиной EMAIL_NOT_FOUND — почту ищем только обходом сайта компании
-- (lib/outreachEmail/findAndVerify.ts), и если на сайте её нет, компания
-- выбывает. При этом в нашем же каталоге Яндекс Карт (10,0 млн карточек)
-- почта есть у 9,4% карточек, а у карточек с сайтом — у 29%; из них 43%
-- содержат адрес на собственном домене компании (остальные — mail.ru и
-- прочие бесплатные, их правила выбора аутрича всё равно отбрасывают).
--
-- Поле website в каталоге — список адресов через запятую, email — тоже.
-- Сопоставляем по домену ПЕРВОГО сайта карточки (16% карточек имеют больше
-- одного; совпадение по второму и далее теряем сознательно — иначе нужен
-- не btree, а разбор списка на лету).

-- Домен первого сайта из списка: общая иммутабельная функция, чтобы индекс и
-- запрос считали ровно одно и то же выражение.
create or replace function public.ymaps_site_domain(p_site text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(
    regexp_replace(
      lower(split_part(coalesce(p_site, ''), ',', 1)),
      '^\s*(https?://)?(www\.)?([^/?#\s]+).*$',
      '\3'
    ),
    ''
  );
$$;

comment on function public.ymaps_site_domain(text) is
  'Домен первого сайта из списка через запятую (поле website каталогов Яндекс Карт). Иммутабельная — под индекс.';

-- Адреса компании по домену: сначала основной каталог, затем организации
-- прошлых парсингов. Строки отдаём как есть, списком через запятую, — разбор
-- и выбор адреса остаются в правилах аутрича (lib/polzaRuOutreach/findEmail.ts).
create or replace function public.polza_ru_catalog_emails(p_domain text)
returns table (emails text, card_url text, source text)
language sql
stable
set statement_timeout = '10s'
as $$
  (
    select y.email, nullif(y.card_url, ''), 'ymaps_catalog'::text
    from public.yandex_maps_company_catalog y
    where y.email <> ''
      and y.website <> ''
      and public.ymaps_site_domain(y.website) = lower(p_domain)
    limit 5
  )
  union all
  (
    select o.email, nullif(o.card_url, ''), 'ymaps_org'::text
    from public.yandex_maps_organizations o
    where coalesce(o.email, '') <> ''
      and coalesce(o.website, '') <> ''
      and public.ymaps_site_domain(o.website) = lower(p_domain)
    limit 5
  );
$$;

revoke all on function public.polza_ru_catalog_emails(text) from public;
grant execute on function public.polza_ru_catalog_emails(text) to service_role;
