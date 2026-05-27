-- Ручная batch-обработка доменов через Mailganer + scrape email + SMTP.
--
-- Клиент загружает CSV с доменами → система прогоняет через scoring +
-- enrichment + валидацию → выдаёт 4 готовых CSV-файла, разделённых по
-- score-bucket'ам.
--
-- Архитектура: async worker (отдельный docker-сервис). API создаёт строку
-- со status=pending, воркер polls и обрабатывает. Прогресс виден через GET
-- /runs/[id].

-- ── 1. Мета прогона ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.client_manual_score_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Имя загруженного файла (для UI отображения)
  source_filename text,
  -- Сколько доменов в исходном файле (после парсинга, до уникальности)
  uploaded_count integer NOT NULL DEFAULT 0,
  -- После дедупа по domain (LOWER, без www.)
  unique_count integer NOT NULL DEFAULT 0,
  -- Статус прогона
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  -- Прогресс обработки (используется UI для прогресс-бара)
  processed_count integer NOT NULL DEFAULT 0,
  -- Финальный breakdown по bucket'ам (заполняется при completed)
  bucket_storage_count integer,         -- score 0-1000
  bucket_medium_count integer,          -- 1001-15000
  bucket_high_count integer,            -- 15001-1000000
  bucket_top_count integer,             -- 1000001+
  -- Аудит времени
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_message text,
  -- Auto-cleanup через 30 дней
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
);

CREATE INDEX IF NOT EXISTS idx_manual_runs_client
  ON public.client_manual_score_runs (client_user_id, started_at DESC);
-- Воркер polls pending — нужен быстрый индекс для FOR UPDATE SKIP LOCKED.
CREATE INDEX IF NOT EXISTS idx_manual_runs_pending
  ON public.client_manual_score_runs (status, started_at)
  WHERE status = 'pending';
-- Cron-task для cleanup использует этот индекс.
CREATE INDEX IF NOT EXISTS idx_manual_runs_expires_at
  ON public.client_manual_score_runs (expires_at);

-- ── 2. Результат по каждому домену ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.client_manual_score_rows (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.client_manual_score_runs(id) ON DELETE CASCADE,
  -- Оригинальная строка из файла клиента (для отладки и для CSV-выгрузки в
  -- исходном виде, если клиент захочет видеть «как было»)
  raw_input text,
  -- Нормализованный domain (LOWER, без www.). NULL если строка не парсится.
  domain text,
  -- Score и метаданные из Mailganer
  score numeric,
  rating text,
  spf text,
  -- Email enrichment — только для score > 1000
  email text,
  email_validation_status text,
  -- В какой bucket попал
  bucket text CHECK (bucket IN ('invalid', 'storage', 'medium', 'high', 'top')),
  -- Если score=0 или какие-то ошибки
  error_message text,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manual_rows_run_bucket
  ON public.client_manual_score_rows (run_id, bucket);

-- ── 3. RLS ───────────────────────────────────────────────────────────────

ALTER TABLE public.client_manual_score_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_manual_score_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Clients see own manual runs" ON public.client_manual_score_runs;
CREATE POLICY "Clients see own manual runs"
  ON public.client_manual_score_runs FOR SELECT
  USING (client_user_id = auth.uid());

DROP POLICY IF EXISTS "Clients insert own manual runs" ON public.client_manual_score_runs;
CREATE POLICY "Clients insert own manual runs"
  ON public.client_manual_score_runs FOR INSERT
  WITH CHECK (client_user_id = auth.uid());

DROP POLICY IF EXISTS "Service role full access on manual_runs" ON public.client_manual_score_runs;
CREATE POLICY "Service role full access on manual_runs"
  ON public.client_manual_score_runs FOR ALL
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Clients see rows from own runs" ON public.client_manual_score_rows;
CREATE POLICY "Clients see rows from own runs"
  ON public.client_manual_score_rows FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.client_manual_score_runs r
       WHERE r.id = run_id AND r.client_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Service role full access on manual_rows" ON public.client_manual_score_rows;
CREATE POLICY "Service role full access on manual_rows"
  ON public.client_manual_score_rows FOR ALL
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON public.client_manual_score_runs TO authenticated;
GRANT ALL ON public.client_manual_score_runs TO service_role;
GRANT SELECT ON public.client_manual_score_rows TO authenticated;
GRANT ALL ON public.client_manual_score_rows TO service_role;
GRANT USAGE, SELECT ON SEQUENCE client_manual_score_rows_id_seq TO service_role;

-- ── 4. Helper для auto-cleanup ───────────────────────────────────────────

-- Воркер вызывает эту функцию при старте — удаляет всё что expires_at < now().
-- Можно также повесить на cron через pg_cron, но воркер-on-start проще.
CREATE OR REPLACE FUNCTION public.cleanup_expired_manual_score_runs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.client_manual_score_runs
   WHERE expires_at < now();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_expired_manual_score_runs() TO service_role;
