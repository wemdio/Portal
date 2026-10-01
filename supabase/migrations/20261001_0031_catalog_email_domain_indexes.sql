-- migrate:no-transaction
--
-- Индексы под поиск почты компании в каталогах Яндекс Карт
-- (`public.polza_ru_catalog_emails`, миграция 20261001_0030).
--
-- Без них запрос по домену — seq scan по yandex_maps_company_catalog
-- (10,0 млн строк, heap 11 ГБ) на каждую компанию запуска: при statement_timeout
-- 10s в функции источник просто всегда отваливался бы по таймауту.
--
-- Индексы частичные — только карточки, у которых есть и почта, и сайт:
-- в каталоге это около 2,8% строк (≈280 тыс.), в организациях ещё меньше.
-- Предикат совпадает с условиями запроса в функции, иначе планировщик
-- индекс не возьмёт.
--
-- concurrently + no-transaction: сборка требует полного обхода heap в 11 ГБ,
-- обычный create index держал бы SHARE и упёрся в lock_timeout деплоя
-- (прецедент 08.08.2026, повтор 01.10.2026 в 20261001_0010).

create index concurrently if not exists idx_ymc_site_domain_email
  on public.yandex_maps_company_catalog (public.ymaps_site_domain(website))
  where email <> '' and website <> '';

create index concurrently if not exists idx_ymo_site_domain_email
  on public.yandex_maps_organizations (public.ymaps_site_domain(website))
  where coalesce(email, '') <> '' and coalesce(website, '') <> '';
