-- Журнал виденных HH-работодателей по клиенту.
-- Используется для:
--   1. Дедупликации между прогонами — не парсим одну компанию дважды.
--   2. Хранения "stored" лидов (score=storage_only_score) — клиент мог бы
--      обработать их вручную позже.
--   3. Аудит/диагностика: что именно cron сделал с каждой компанией.

CREATE TABLE IF NOT EXISTS public.client_auto_pipeline_seen_employers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Идентификация компании
  hh_employer_id text NOT NULL,
  hh_employer_name text,
  domain text,
  site_url text,

  -- Что вернул scoring endpoint
  endpoint_score numeric,
  endpoint_spf text,
  endpoint_raw jsonb,            -- полный ответ для диагностики

  -- Какой email мы нашли через stepFindEmails
  resolved_email text,

  -- Куда отправили (если status=routed)
  routed_bucket_id text,         -- id из score_buckets
  routed_campaign_id text,       -- instantly_campaign_id

  -- Статус обработки
  status text NOT NULL CHECK (status IN ('enqueued', 'routed', 'stored', 'skipped', 'failed')),
  skip_reason text,              -- 'no_email' | 'no_score' | 'score_out_of_buckets' | ...
  error_message text,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,

  UNIQUE (client_user_id, hh_employer_id)
);

COMMENT ON TABLE public.client_auto_pipeline_seen_employers IS
  'Журнал обработки HH-работодателей в авто-пайплайне. Главное — дедуп между прогонами по (client_user_id, hh_employer_id).';
COMMENT ON COLUMN public.client_auto_pipeline_seen_employers.status IS
  'enqueued — попал в прогон, ещё не обработан. routed — отправлен в Instantly. stored — сохранён по storage_only_score. skipped — нет email/нет score/score вне buckets. failed — ошибка при отправке.';

CREATE INDEX IF NOT EXISTS idx_seen_employers_client_status
  ON public.client_auto_pipeline_seen_employers(client_user_id, status);
CREATE INDEX IF NOT EXISTS idx_seen_employers_client_processed
  ON public.client_auto_pipeline_seen_employers(client_user_id, processed_at DESC);

ALTER TABLE public.client_auto_pipeline_seen_employers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Clients can read own seen employers" ON public.client_auto_pipeline_seen_employers;
CREATE POLICY "Clients can read own seen employers"
  ON public.client_auto_pipeline_seen_employers
  FOR SELECT
  USING (client_user_id = auth.uid());

DROP POLICY IF EXISTS "Service role full access on seen_employers" ON public.client_auto_pipeline_seen_employers;
CREATE POLICY "Service role full access on seen_employers"
  ON public.client_auto_pipeline_seen_employers
  FOR ALL
  USING (true)
  WITH CHECK (true);

GRANT ALL ON public.client_auto_pipeline_seen_employers TO service_role;
GRANT ALL ON public.client_auto_pipeline_seen_employers TO postgres;
GRANT SELECT ON public.client_auto_pipeline_seen_employers TO authenticated;
