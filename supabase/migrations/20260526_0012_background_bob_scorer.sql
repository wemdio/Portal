-- Background BoB Scorer: фоновый воркер, который 24/7 прогоняет BoB-домены
-- через Mailganer и наполняет mailganer_domain_scores кэш.
--
-- Архитектура:
--   1. Расширяем mailganer_domain_scores — добавляем BoB-метаданные (name,
--      area, employees_count, industries). Когда фоновый scorer scoring'ит
--      домен, сохраняет рядом всю инфу о компании. Так orchestrator BoB-
--      добор (Iter 3) сможет брать готовые HhEmployer'ы прямо из кэша
--      без обращения к BoB.
--
--   2. Создаём background_scorer_state — singleton-таблица состояния:
--      enabled flag, offset для resilience после redeploy, счётчики.

-- ── 1. Расширяем mailganer_domain_scores ─────────────────────────────────

ALTER TABLE public.mailganer_domain_scores
  ADD COLUMN IF NOT EXISTS company_name text,
  ADD COLUMN IF NOT EXISTS area text,
  ADD COLUMN IF NOT EXISTS employees_count integer,
  ADD COLUMN IF NOT EXISTS industries jsonb,
  ADD COLUMN IF NOT EXISTS bob_inn text;

COMMENT ON COLUMN public.mailganer_domain_scores.company_name IS
  'Имя компании из BoB (если scored через background scorer). Для cron-источника NULL.';
COMMENT ON COLUMN public.mailganer_domain_scores.bob_inn IS
  'ИНН из BoB — стабильная ссылка на companies_directory.id (jsonb).';

-- Композитный индекс для быстрого «дай N активных доменов из кэша которых
-- ещё нет в seen_employers клиента» — главная query для Iter 3.
CREATE INDEX IF NOT EXISTS idx_mailganer_scores_active_company
  ON public.mailganer_domain_scores (score DESC, scored_at DESC)
  WHERE score > 0 AND company_name IS NOT NULL;

-- ── 2. background_scorer_state ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.background_scorer_state (
  -- Singleton: всегда только одна строка (id = 1)
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Глобальный switch — admin/клиент может выключить через UI
  enabled boolean NOT NULL DEFAULT false,
  -- Offset в companies_directory для resilience после redeploy.
  -- При SIGTERM worker сохраняет offset, при старте читает и продолжает.
  current_offset bigint NOT NULL DEFAULT 0,
  -- Метрики прогресса
  domains_scored_total bigint NOT NULL DEFAULT 0,
  domains_active_total bigint NOT NULL DEFAULT 0,
  -- Последний успешный tick — для UI «работает ли воркер» индикатора
  last_tick_at timestamptz,
  last_tick_batch_size integer,
  last_error text,
  last_error_at timestamptz,
  -- Конфигурация скорости (правится через UI)
  batch_size integer NOT NULL DEFAULT 50,
  sleep_between_batches_ms integer NOT NULL DEFAULT 2000,
  revenue_from bigint NOT NULL DEFAULT 40000000
);

-- Засеваем singleton-строку. Без неё первый запуск воркера упадёт.
INSERT INTO public.background_scorer_state (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.background_scorer_state IS
  'Singleton-состояние фонового BoB scorer''а. Одна строка (id=1) на весь портал.';

-- ── 3. RLS ─────────────────────────────────────────────────────────────

ALTER TABLE public.background_scorer_state ENABLE ROW LEVEL SECURITY;

-- Service role — full
DROP POLICY IF EXISTS "Service role full access on background_scorer_state"
  ON public.background_scorer_state;
CREATE POLICY "Service role full access on background_scorer_state"
  ON public.background_scorer_state
  FOR ALL USING (true) WITH CHECK (true);

-- Authenticated users (admin + client) — read-only.
-- UI'у нужно только показать прогресс. Toggle enabled делается через API
-- эндпоинт с service-role (Iter 3).
DROP POLICY IF EXISTS "Authenticated read background_scorer_state"
  ON public.background_scorer_state;
CREATE POLICY "Authenticated read background_scorer_state"
  ON public.background_scorer_state
  FOR SELECT USING (auth.role() = 'authenticated');

GRANT SELECT ON public.background_scorer_state TO authenticated;
GRANT ALL    ON public.background_scorer_state TO service_role;
