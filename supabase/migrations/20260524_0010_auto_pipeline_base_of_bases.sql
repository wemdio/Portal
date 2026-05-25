-- База баз (companies_directory) как дополнительный источник к HH.
--
-- HH публикует ~96k вакансий/день в РФ, ~5-10k уникальных компаний при
-- парсинге по 30 индустриям. Этого хватает на ~300-600 ready/день,
-- но цель 15-20k/мес требует ~670 ready/день — нужно добирать.
--
-- BoB (companies_directory) — наш ФНС-датасет из 2.2М компаний с revenue,
-- emails, телефонами и сайтами. Берём оттуда столько, чтобы суммарно с HH
-- получить daily_target_employers компаний на enrichment. Фильтр revenue
-- ≥40М исключает пустые ИП без реальной деятельности.

-- 1. seen_employers получает source — чтобы видеть откуда пришёл employer.
ALTER TABLE public.client_auto_pipeline_seen_employers
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'hh'
    CHECK (source IN ('hh', 'base_of_bases'));

COMMENT ON COLUMN public.client_auto_pipeline_seen_employers.source IS
  '''hh'' — пришла из HH /vacancies; ''base_of_bases'' — из companies_directory_fetch_rpc.';

-- 2. configs получает три поля под BoB.
ALTER TABLE public.client_auto_pipeline_configs
  ADD COLUMN IF NOT EXISTS base_of_bases_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS base_of_bases_revenue_from bigint NOT NULL DEFAULT 40000000,
  ADD COLUMN IF NOT EXISTS daily_target_employers integer NOT NULL DEFAULT 10000;

COMMENT ON COLUMN public.client_auto_pipeline_configs.base_of_bases_enabled IS
  'true — после HH парсинга добираем недостающее из companies_directory; false — только HH.';
COMMENT ON COLUMN public.client_auto_pipeline_configs.base_of_bases_revenue_from IS
  'Минимальный годовой оборот компании из BoB (в рублях). Default 40М — отсекает пустые ИП.';
COMMENT ON COLUMN public.client_auto_pipeline_configs.daily_target_employers IS
  'Целевое количество компаний на enrichment за прогон. HH парсит сколько может, BoB добирает остаток. Конверсия parsed→ready ~6.3% → 10000 target ≈ 630 ready/день ≈ 19k/мес.';
