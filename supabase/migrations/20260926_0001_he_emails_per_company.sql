-- ENG (Движок вертикалей, he_*): «до N адресов одной компании» становится
-- данными вместо захардкоженной пятёрки в step_config конструктора.
--
-- ЗАЧЕМ. Шаг конструктора `cap_emails_per_company` получал `{ max: 5 }`
-- константой из стадии base_collect. Пока в ENG-сетке не было шага
-- `split_emails`, все адреса компании жили в ОДНОЙ ячейке, шаг считал строки и
-- поэтому не делал ничего. С разносом адресов по строкам лимит начинает
-- работать по-настоящему — и должен стать выбором (владелец: «клиент выбирает
-- сколько адресов на компанию»), а не константой в коде.
--
-- МОДЕЛЬ — как у V2 (`20260920_0001_ve_emails_per_company.sql`), но своими
-- колонками: значение проекта (дефолт для новых сборок) + значение базы
-- (действует на эту сборку, снимается с проекта один раз на постановке) +
-- запись о том, какой лимит реально применён (для последующего ужесточения без
-- повторной оплаты сборки). Функций и RPC, в отличие от V2, здесь нет: ENG
-- применяет лимит шагом конструктора, а не разбиением готовой базы.
--
-- NULL = поведение до этой миграции: стадия подставляет прежнюю пятёрку
-- (HE_MAX_EMAILS_PER_COMPANY_DEFAULT). Ни один существующий проект, база или
-- запущенная кампания не меняются. RU-инструмент специалиста не меняется тем
-- более: у RU-сборки в списке шагов нет `split_emails`, компания занимает одну
-- строку и лимит остаётся no-op при любом значении.
--
-- ПРАВА. Новых ОБЪЕКТОВ (таблиц, функций) миграция не создаёт — только
-- колонки, а они наследуют права своих таблиц (тот же довод, что в
-- `20260730_0003_he_auto_collect.sql`). Поэтому ни `grant`, ни поимённого
-- `revoke` здесь нет: правилам `app/src/lib/migrationLint.ts` (GRANT для
-- `service_role` у новых таблиц и поимённый отзыв у `anon`/`authenticated` для
-- новых объектов движков) проверять в этом файле нечего. Сами he_projects и
-- he_bases заперты от `anon`/`authenticated` в
-- `20260920_0001_he_rls_lockdown.sql` и остаются запертыми.
--
-- Миграция идемпотентна: `add column if not exists` + `drop constraint if
-- exists` перед `add constraint` можно гонять повторно.

-- ─── 1. Колонки ──────────────────────────────────────────────────────────

alter table public.he_projects
  add column if not exists max_emails_per_company integer;

alter table public.he_bases
  add column if not exists max_emails_per_company integer;

alter table public.he_bases
  add column if not exists contact_cap_applied integer;

-- ─── 2. Границы значения ─────────────────────────────────────────────────
-- 1..100: ноль или отрицательное — не «без лимита», а опечатка, которая молча
-- обнулила бы базу; сотня с запасом закрывает любую осмысленную настройку.
-- Границы обязаны совпадать с HE_MAX_EMAILS_PER_COMPANY_MIN/MAX в
-- app/src/lib/hypothesisEngine/baseCollectEnqueue.ts.

alter table public.he_projects
  drop constraint if exists he_projects_max_emails_per_company_check;
alter table public.he_projects
  add constraint he_projects_max_emails_per_company_check
  check (max_emails_per_company is null or max_emails_per_company between 1 and 100);

alter table public.he_bases
  drop constraint if exists he_bases_max_emails_per_company_check;
alter table public.he_bases
  add constraint he_bases_max_emails_per_company_check
  check (max_emails_per_company is null or max_emails_per_company between 1 and 100);

alter table public.he_bases
  drop constraint if exists he_bases_contact_cap_applied_check;
alter table public.he_bases
  add constraint he_bases_contact_cap_applied_check
  check (contact_cap_applied is null or contact_cap_applied between 1 and 100);

-- ─── 3. Комментарии ──────────────────────────────────────────────────────

comment on column public.he_projects.max_emails_per_company is
  'ENG: сколько адресов одной компании брать в работу по умолчанию для новых авто-сборок проекта (NULL = дефолт движка).';
comment on column public.he_bases.max_emails_per_company is
  'ENG: действующий для этой базы лимит адресов на компанию (снят с проекта при постановке сборки; NULL = дефолт движка).';
comment on column public.he_bases.contact_cap_applied is
  'ENG: лимит, реально применённый конструктором к этой базе (NULL = конструктор капа не применял).';
