-- OutreachOS: 2GIS top-up — добор контактов из 2gis_dataset в дни недобора HH+SJ.
-- Дизайн: docs/design/2026-08-11-outreachos-2gis-topup.md.
--
-- ГИС-лиды льются в те же кампании A/B через существующий детерминированный
-- сплит по домену компании (шаг 9 pipelineRunner) — отдельная кампания C НЕ
-- заводится (решение по атрибуции из §7 дизайн-дока).

-- ── 1. Конфиг top-up'а (outreachos_pipeline_config) ───────────────────────
ALTER TABLE public.outreachos_pipeline_config
  ADD COLUMN IF NOT EXISTS gis_topup_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gis_topup_target_appended int NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS gis_topup_rubric_groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS gis_topup_daily_cap int NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS gis_topup_measure_only boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.outreachos_pipeline_config.gis_topup_enabled IS
  '2GIS top-up: мастер-выключатель добора из 2gis_dataset при недоборе HH+SJ.';
COMMENT ON COLUMN public.outreachos_pipeline_config.gis_topup_target_appended IS
  'Цель: суммарно залито A+B за прогон. Дефицит = target − keptLeads после LLM.';
COMMENT ON COLUMN public.outreachos_pipeline_config.gis_topup_rubric_groups IS
  'Рубрикатор 2GIS, формат как gis_signal_segments.rubric_groups: [{category, includedSubcategories[], excludedSubcategories[]}].';
COMMENT ON COLUMN public.outreachos_pipeline_config.gis_topup_daily_cap IS
  'Потолок кандидатов 2GIS за прогон (защита конструктора и бюджета валидации).';
COMMENT ON COLUMN public.outreachos_pipeline_config.gis_topup_measure_only IS
  'true → фазы 8t.1–8t.4 выполняются и пишут счётчики, но GIS-лиды НЕ заливаются и seen по ним НЕ пишется (замер воронки добора).';

-- ── 2. Телеметрия top-up'а (outreachos_pipeline_runs) ─────────────────────
-- NULL = top-up в этом прогоне не запускался (выключен / deficit=0 / measure_only основного пайплайна).
ALTER TABLE public.outreachos_pipeline_runs
  ADD COLUMN IF NOT EXISTS gis_pulled int,
  ADD COLUMN IF NOT EXISTS gis_after_dedup int,
  ADD COLUMN IF NOT EXISTS gis_valid_contacts int,
  ADD COLUMN IF NOT EXISTS gis_llm_kept int,
  ADD COLUMN IF NOT EXISTS gis_appended int;

COMMENT ON COLUMN public.outreachos_pipeline_runs.gis_pulled IS
  '2GIS top-up: карточек взято из потока 2gis_dataset после внутреннего дедупа (по twogis_id и домену).';
COMMENT ON COLUMN public.outreachos_pipeline_runs.gis_after_dedup IS
  '2GIS top-up: компаний ушло в конструктор (после кросс-дедупов seen/gis_signal/батч + B2C-отсева + suppression).';
COMMENT ON COLUMN public.outreachos_pipeline_runs.gis_valid_contacts IS
  '2GIS top-up: валидных контактов на выходе второго конструктор-джоба.';
COMMENT ON COLUMN public.outreachos_pipeline_runs.gis_llm_kept IS
  '2GIS top-up: лидов осталось после LLM-отсева (контекст = рубрики 2GIS).';
COMMENT ON COLUMN public.outreachos_pipeline_runs.gis_appended IS
  '2GIS top-up: лидов реально принято Instantly (0 в measure_only-режиме топ-апа).';

-- ── 3. outreachos_seen_employers: hh_employer_id становится NULLABLE ──────
-- GIS-компании пишутся в тот же журнал с hh_employer_id = NULL (дедуп по
-- domain — общий ключ между HH- и 2GIS-мирами). PRIMARY KEY не допускает
-- NULL → заменяем его UNIQUE-индексом по hh_employer_id: семантика для
-- HH-строк сохраняется (уникальность не-NULL значений + upsert
-- onConflict=hh_employer_id продолжает работать), а NULL-строки GIS
-- допускаются (Postgres: NULL'ы в unique-индексе не конфликтуют).
-- markSeen для GIS-строк делает delete+insert по domain, поэтому дублей
-- NULL-строк по одному домену не накапливается.
ALTER TABLE public.outreachos_seen_employers
  DROP CONSTRAINT IF EXISTS outreachos_seen_employers_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS outreachos_seen_employers_hh_employer_id_key
  ON public.outreachos_seen_employers (hh_employer_id);

-- Индекс по domain существовал с 20260623_0001 — пересоздаём идемпотентно,
-- чтобы миграция была самодостаточной (дедуп GIS-компаний идёт по domain).
CREATE INDEX IF NOT EXISTS idx_outreachos_seen_domain
  ON public.outreachos_seen_employers (domain);

COMMENT ON COLUMN public.outreachos_seen_employers.hh_employer_id IS
  'Числовой id работодателя HH. NULL = компания из 2GIS top-up (у неё нет hh id; дедуп по domain).';

NOTIFY pgrst, 'reload schema';
