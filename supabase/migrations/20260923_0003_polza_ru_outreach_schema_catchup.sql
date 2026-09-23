-- «Наш автоаутрич»: догоняем схему до текущей 20260922_0008_polza_ru_outreach.sql.
--
-- 0008 применилась на проде 23.09.2026 в первой версии (три оффера:
-- profile_code, allowed_profiles), а потом файл переписали под роутер шести
-- цепочек. Таблицы уже были, `create table if not exists` их пропустил, и
-- новых колонок в базе нет: запуски падают на chain_type / industry_groups,
-- а вставка в журнал — на not null у profile_code. Здесь то же, что в новой
-- 0008, но через alter; на базе, где 0008 сразу была новой, всё — no-op.
--
-- Файл сортируется до 20260923_0004_polza_cases_from_site.sql: та пишет в
-- industry_groups и без этой миграции падает.

-- ── Журнал запуска ──────────────────────────────────────────────────────────
alter table public.polza_ru_outreach_companies
  drop column if exists profile_code,
  add column if not exists chain_type text,
  add column if not exists amo_status text,
  add column if not exists ta_score integer,
  add column if not exists ta_reason text,
  add column if not exists priority_score integer,
  add column if not exists email_verification text,
  add column if not exists case_match_reason text,
  add column if not exists campaign_hypothesis text;

alter table public.polza_ru_outreach_companies
  drop constraint if exists polza_ru_outreach_companies_chain_type_check;
alter table public.polza_ru_outreach_companies
  add constraint polza_ru_outreach_companies_chain_type_check
  check (chain_type in ('reactivation', 'hiring', 'ad_budget', 'event', 'growth_event', 'icp_only'));

-- ── Утверждения оффера ──────────────────────────────────────────────────────
alter table public.polza_ru_offer_claims
  drop column if exists profile_code,
  add column if not exists chain_type text not null default 'all';

alter table public.polza_ru_offer_claims
  drop constraint if exists polza_ru_offer_claims_chain_type_check;
alter table public.polza_ru_offer_claims
  add constraint polza_ru_offer_claims_chain_type_check
  check (chain_type in ('reactivation', 'hiring', 'ad_budget', 'event', 'growth_event', 'icp_only', 'all'));

-- ── Кейсы ───────────────────────────────────────────────────────────────────
alter table public.polza_ru_cases
  drop column if exists allowed_profiles,
  add column if not exists industry_groups text[] not null default '{}',
  add column if not exists allowed_chains text[] not null default '{}';

-- ── Сигнальные загрузки: добавился вид 'growth' (гранты, акселераторы) ──────
alter table public.polza_ru_signal_uploads
  drop constraint if exists polza_ru_signal_uploads_kind_check;
alter table public.polza_ru_signal_uploads
  add constraint polza_ru_signal_uploads_kind_check
  check (kind in ('exhibitors', 'contracts', 'growth'));

alter table public.polza_ru_signal_rows
  drop constraint if exists polza_ru_signal_rows_kind_check;
alter table public.polza_ru_signal_rows
  add constraint polza_ru_signal_rows_kind_check
  check (kind in ('exhibitors', 'contracts', 'growth'));

-- ── Черновики кейсов из базы знаний (как в 0008) ────────────────────────────
insert into public.polza_ru_cases
  (case_id, public_name, industry_groups, case_text_short, source_file_or_url, status, legal_publication_approved, notes)
values
  ('bpmsoft_telecom', 'Умные Новации (BPMSoft)', '{it_saas}',
   'для «Умных Новаций», которые продают телеком-операторам CRM на платформе BPMSoft, собрали и проверили базу из 830 компаний и провели 4 итерации тестов офферов — 240 ответов, 25 MQL и 21 SQL.',
   'kb_documents: «Умные Новации — CRM Telecom 360»', 'draft', false, 'Черновик 23.09.2026 по базе знаний: сверить цифры и разрешение клиента.'),
  ('kkzsk', 'ККЗСК', '{manufacturing}',
   'для производителя металлоконструкций ККЗСК собрали базу контактов через HeadHunter и запустили персонализированные цепочки — 24 лида при 13,6% ответов.',
   'he_cases: ККЗСК', 'draft', false, 'Черновик 23.09.2026: проверить написание названия (в базе «ККЗСК», у CEO «КЗСК»).'),
  ('uremont', 'Uremont', '{auto_logistics}',
   'для Uremont, платформы обслуживания корпоративных автопарков, провели 12 кампаний по базе из 11 535 контактов — 28 квалифицированных лидов.',
   'he_cases: Uremont', 'draft', false, 'Черновик 23.09.2026 по базе знаний.'),
  ('drink_and_eat', 'Чашка-вкусняшка (Drink-and-eat)', '{horeca}',
   'для производителя съедобных стаканчиков «Чашка-вкусняшка» вышли на кофейни, кафе, рестораны и отели — 87,5 квалифицированных лидов за 2 месяца.',
   'kb_documents: «Чашка-вкусняшка (Drink-and-eat)»', 'draft', false, 'Черновик 23.09.2026: в источнике дробное «87,5 лидов» — уточнить цифру.'),
  ('victory_group', 'Victory Group', '{digital_agency}',
   'для digital-агентства Victory Group, которое работает со стоматологиями и девелоперами, получили 54 лида.',
   've_cases: Victory Group', 'draft', false, 'Черновик 23.09.2026: в источнике нет периода — уточнить.'),
  ('compass_c', 'Компас С', '{manufacturing}',
   'для дистрибьютора принтеров этикеток и сканеров штрих-кода «Компас С» вышли на реселлеров и интеграторов — 10 лидов за месяц.',
   'kb_documents: «Компас С (Compass-c)»', 'draft', false, 'Черновик 23.09.2026 по базе знаний.')
on conflict (case_id) do nothing;

-- ── Кандидаты для цепочки «Только профиль» (как в 0008) ─────────────────────
create or replace function public.polza_ru_directory_candidates(
  p_min_revenue bigint,
  p_max_revenue bigint,
  p_min_employees integer,
  p_limit integer
)
returns table (
  inn text,
  name text,
  website text,
  revenue bigint,
  employees_count integer,
  okved_code text
)
language sql
volatile
set statement_timeout = '60s'
as $$
  select d.inn, d.name, d.website, d.revenue, d.employees_count, d.okved_code
  from public.companies_directory d
  where d.website is not null and d.website <> ''
    and d.revenue between p_min_revenue and p_max_revenue
    and coalesce(d.employees_count, 0) >= p_min_employees
    and coalesce(d.okved_code, '') !~ '^(47|55|56|96)'
  order by random()
  limit least(greatest(p_limit, 1), 5000);
$$;

revoke all on function public.polza_ru_directory_candidates(bigint, bigint, integer, integer) from public;
grant execute on function public.polza_ru_directory_candidates(bigint, bigint, integer, integer) to service_role;
