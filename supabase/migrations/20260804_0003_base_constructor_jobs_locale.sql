-- Конструктор баз: локаль джобы — 'ru' (дефолт, обратная совместимость) или
-- 'en'. Ведёт канонические имена/алиасы колонок (Company/Site/Email вместо
-- кириллических), заголовок найденной email-колонки ('Found Email'), язык
-- скрапера сайтов (Accept-Language, EN-пути страниц) и списки нескрапабельных
-- хостов. AI-шаги (ta_scoring/personalization/clean_names) для 'en' в MVP не
-- используются — генерация и скоринг остаются в Движке вертикалей.
-- Джобы с locale='en' создаёт Движок вертикалей (фаза CONSTRUCT авто-сбора
-- базы под us-проекты), см. lib/hypothesisEngine/stages/baseCollect.ts.

alter table public.base_constructor_jobs
  add column if not exists locale text not null default 'ru';

alter table public.base_constructor_jobs
  drop constraint if exists base_constructor_jobs_locale_check;

alter table public.base_constructor_jobs
  add constraint base_constructor_jobs_locale_check
  check (locale in ('ru','en'));
