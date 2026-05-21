-- Конфиг авто-пайплайна на клиента.
-- Одна строка на клиента. score_buckets — динамический список цепочек, по
-- одной на диапазон score'а от endpoint'а клиента. storage_only_score
-- (default 0) — особое значение скора, при котором лиды НЕ отправляются,
-- а только записываются в seen_employers со status=stored (для возможной
-- обработки в будущем).
--
-- Структура одного bucket'а в score_buckets:
--   {
--     "id": "<uuid>",
--     "label": "<человеческое имя, для UI>",
--     "score_min": <number>,
--     "score_max": <number | null>,      -- null = без верхней границы
--     "instantly_campaign_id": "<id или null до bootstrap>",
--     "sequence": {
--       "name": "<имя для Instantly>",
--       "steps": [
--         { "subject": "...", "body": "...", "wait_days": 0,
--           "variants": [ { "subject": "...", "body": "..." }, ... ] },
--         { "subject": "...", "body": "...", "wait_days": 3 },
--         ...
--       ]
--     }
--   }
--
-- Тот же формат, что и ClientLaunchSequence в lib/clientLaunch/types — это
-- осознанно, чтобы runClientLaunch принимал готовый объект без преобразований.

CREATE TABLE IF NOT EXISTS public.client_auto_pipeline_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,

  -- Scoring endpoint клиента
  endpoint_url text,
  endpoint_api_key text,
  endpoint_timeout_ms integer NOT NULL DEFAULT 10000,

  -- Цепочки и роутинг
  score_buckets jsonb NOT NULL DEFAULT '[]'::jsonb,
  storage_only_score numeric,

  -- Ограничители прогона
  daily_limit integer,           -- NULL = брать из тарифа
  hh_date_window_hours integer NOT NULL DEFAULT 24,
  hh_extra_exclude_patterns jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Метаданные прогонов
  last_run_at timestamptz,
  last_run_status text CHECK (last_run_status IS NULL OR last_run_status IN ('running', 'completed', 'failed')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (client_user_id)
);

COMMENT ON TABLE public.client_auto_pipeline_configs IS
  'Конфиг авто-пайплайна на клиента. Одна строка на client_user_id. Заполняется админом через /admin/clients/[id]/preset.';
COMMENT ON COLUMN public.client_auto_pipeline_configs.score_buckets IS
  'Массив bucket''ов: каждый — диапазон score → цепочка → instantly_campaign_id. Формат идентичен ClientLaunchSequence.';
COMMENT ON COLUMN public.client_auto_pipeline_configs.storage_only_score IS
  'Особый score — лиды с таким значением сохраняются в seen_employers со status=stored, но НЕ отправляются. NULL = функция отключена.';
COMMENT ON COLUMN public.client_auto_pipeline_configs.daily_limit IS
  'Максимум новых лидов в один прогон. NULL — использовать лимит из client_tariffs.';

CREATE INDEX IF NOT EXISTS idx_client_auto_pipeline_configs_enabled
  ON public.client_auto_pipeline_configs(client_user_id)
  WHERE enabled = true;

ALTER TABLE public.client_auto_pipeline_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Clients can read own auto-pipeline config" ON public.client_auto_pipeline_configs;
CREATE POLICY "Clients can read own auto-pipeline config"
  ON public.client_auto_pipeline_configs
  FOR SELECT
  USING (client_user_id = auth.uid());

DROP POLICY IF EXISTS "Service role full access on client_auto_pipeline_configs" ON public.client_auto_pipeline_configs;
CREATE POLICY "Service role full access on client_auto_pipeline_configs"
  ON public.client_auto_pipeline_configs
  FOR ALL
  USING (true)
  WITH CHECK (true);

GRANT ALL ON public.client_auto_pipeline_configs TO service_role;
GRANT ALL ON public.client_auto_pipeline_configs TO postgres;
GRANT SELECT ON public.client_auto_pipeline_configs TO authenticated;
