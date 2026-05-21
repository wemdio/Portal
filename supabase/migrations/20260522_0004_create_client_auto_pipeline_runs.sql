-- Журнал прогонов авто-пайплайна.
-- Одна запись на каждый cron-tick для каждого клиента. Нужно для:
--   * Дашборда клиента — «последний прогон, X лидов добавлено».
--   * Админской диагностики — почему упал прогон, что обработал.
--   * Метрик за период — сколько лидов прошло через систему.

CREATE TABLE IF NOT EXISTS public.client_auto_pipeline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),

  -- Метрики
  parsed_count integer NOT NULL DEFAULT 0,    -- работодателей нашли на HH
  new_count integer NOT NULL DEFAULT 0,       -- после дедупа против seen_employers
  routed_count integer NOT NULL DEFAULT 0,    -- ушли в Instantly
  stored_count integer NOT NULL DEFAULT 0,    -- сохранены по storage_only_score
  skipped_count integer NOT NULL DEFAULT 0,   -- пропущены (нет email/нет score)
  failed_count integer NOT NULL DEFAULT 0,    -- ошибки при отправке

  -- Если прогон упал целиком
  error_message text,

  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

COMMENT ON TABLE public.client_auto_pipeline_runs IS
  'Журнал прогонов авто-пайплайна. Используется дашбордом клиента и админской диагностикой.';

CREATE INDEX IF NOT EXISTS idx_auto_pipeline_runs_client_started
  ON public.client_auto_pipeline_runs(client_user_id, started_at DESC);

ALTER TABLE public.client_auto_pipeline_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Clients can read own auto-pipeline runs" ON public.client_auto_pipeline_runs;
CREATE POLICY "Clients can read own auto-pipeline runs"
  ON public.client_auto_pipeline_runs
  FOR SELECT
  USING (client_user_id = auth.uid());

DROP POLICY IF EXISTS "Service role full access on auto_pipeline_runs" ON public.client_auto_pipeline_runs;
CREATE POLICY "Service role full access on auto_pipeline_runs"
  ON public.client_auto_pipeline_runs
  FOR ALL
  USING (true)
  WITH CHECK (true);

GRANT ALL ON public.client_auto_pipeline_runs TO service_role;
GRANT ALL ON public.client_auto_pipeline_runs TO postgres;
GRANT SELECT ON public.client_auto_pipeline_runs TO authenticated;
