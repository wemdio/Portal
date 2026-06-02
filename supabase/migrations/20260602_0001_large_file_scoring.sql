-- Large-file domain scoring.
--
-- Клиент загружает огромный файл (миллионы доменов) в «Ручную обработку»,
-- уходит — домены скорятся в фоне (ТОЛЬКО скоринг) в общий кэш
-- mailganer_domain_scores (= резерв) с настраиваемым RPS, и процесс
-- переживает редеплои (всё состояние в БД на DB-сервере, не на app-сервере).
--
-- Низ уже построен: активные домены (score>0) из кэша существующий добор
-- сам превращает в лидов (парсинг почт + валидация) и льёт в кампании.
-- Здесь — только «вход»: файл -> очередь -> скоринг в кэш.
--
-- Новое:
--   1. concurrency на background_scorer_state — RPS-потолок (был захардкожен 5).
--   2. large_score_jobs   — один джоб на загруженный файл (ссылка на S3 + прогресс).
--   3. large_score_domains — очередь работы по доменам (pending -> scored).

-- ── 1. Настраиваемый concurrency (= RPS-потолок к Mailganer) ──────────────
-- ADD COLUMN ... DEFAULT заполнит и существующую singleton-строку (id=1) → 15.
ALTER TABLE public.background_scorer_state
  ADD COLUMN IF NOT EXISTS concurrency integer NOT NULL DEFAULT 15;

COMMENT ON COLUMN public.background_scorer_state.concurrency IS
  'Сколько параллельных запросов к Mailganer = фактический RPS-потолок. Было захардкожено 5; правится из админ-панели. Mailganer рекомендовал старт 10, мы используем 15.';

-- ── 2. large_score_jobs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.large_score_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Кто загрузил (для клиентского UI прогресса + аудита).
  client_user_id uuid NOT NULL,
  source_filename text NOT NULL,
  -- Ключ исходного файла в S3 (файл там и лежит — переживает редеплои).
  s3_key text NOT NULL,
  status text NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading','parsing','scoring','completed','failed','cancelled')),
  -- Счётчики прогресса (обновляются по ходу парсинга/скоринга).
  total_domains  bigint NOT NULL DEFAULT 0,  -- уникальных доменов в очереди после чистки
  parsed_domains bigint NOT NULL DEFAULT 0,  -- сколько прочитано из файла на этапе parsing
  scored_domains bigint NOT NULL DEFAULT 0,  -- реально дёрнули Mailganer
  active_domains bigint NOT NULL DEFAULT 0,  -- из них score>0
  cached_domains bigint NOT NULL DEFAULT 0,  -- пропущено (уже было в кэше)
  junk_domains   bigint NOT NULL DEFAULT 0,  -- отброшено как мусор/дубли на парсинге
  error_message text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_large_score_jobs_client
  ON public.large_score_jobs (client_user_id, created_at DESC);
-- Воркер ищет активные джобы для обработки.
CREATE INDEX IF NOT EXISTS idx_large_score_jobs_active
  ON public.large_score_jobs (created_at)
  WHERE status IN ('parsing','scoring');

-- ── 3. large_score_domains (очередь работы) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.large_score_domains (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.large_score_jobs(id) ON DELETE CASCADE,
  domain text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','scored','cached','error')),
  scored_at timestamptz
);

-- Drain-запрос воркера: «дай N pending-доменов джоба». Partial-индекс по pending,
-- чтобы по мере обработки он сжимался и оставался быстрым на миллионах строк.
CREATE INDEX IF NOT EXISTS idx_large_score_domains_pending
  ON public.large_score_domains (job_id, id)
  WHERE status = 'pending';

-- Дедуп внутри файла: один домен не ставится в очередь дважды для одного джоба
-- (INSERT ... ON CONFLICT DO NOTHING при стейджинге).
CREATE UNIQUE INDEX IF NOT EXISTS uq_large_score_domains_job_domain
  ON public.large_score_domains (job_id, domain);

-- ── 4. RLS ───────────────────────────────────────────────────────────────
ALTER TABLE public.large_score_jobs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.large_score_domains ENABLE ROW LEVEL SECURITY;

-- Service role (сервер + воркер) — полный доступ.
DROP POLICY IF EXISTS "Service role full access on large_score_jobs" ON public.large_score_jobs;
CREATE POLICY "Service role full access on large_score_jobs"
  ON public.large_score_jobs FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on large_score_domains" ON public.large_score_domains;
CREATE POLICY "Service role full access on large_score_domains"
  ON public.large_score_domains FOR ALL USING (true) WITH CHECK (true);

-- Клиент читает только свои джобы (для UI прогресса, если читает напрямую).
DROP POLICY IF EXISTS "Client reads own large_score_jobs" ON public.large_score_jobs;
CREATE POLICY "Client reads own large_score_jobs"
  ON public.large_score_jobs FOR SELECT USING (auth.uid() = client_user_id);

GRANT SELECT ON public.large_score_jobs    TO authenticated;
GRANT ALL    ON public.large_score_jobs    TO service_role;
GRANT ALL    ON public.large_score_domains TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.large_score_domains_id_seq TO service_role;
