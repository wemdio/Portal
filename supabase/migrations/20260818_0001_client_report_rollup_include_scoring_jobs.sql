-- Rollup воронки: учитывать не только ЗАВЕРШЁННЫЕ большие файлы, но и те,
-- что ещё скорятся.
--
-- Проблема (18.08.2026). Снапшот `client_report_large_score_rollup_*` брал
-- строки только из джобов со статусом 'completed'. Большой файл скорится
-- ~40 дней, поэтому всё это время его отскоренные домены не попадали в
-- «Аналитику / Воронку базы» — клиент видел нули по новому файлу, а цифры
-- прыгнули бы разом в конце. Хуже того, guard `assertPlanCoverage` в
-- операторском скрипте считает такие строки «непокрытыми» и роняет ежедневную
-- автопересборку (крон 09:00 МСК).
--
-- Почему включать безопасно: снапшот и так ограничен `source_watermark`, а в
-- выборку попадают ТОЛЬКО строки со `status IN ('scored','error')`. Статус
-- джоба не влияет на то, что конкретная строка уже отскорена — «в процессе»
-- меняет лишь то, сколько строк добавится ПОЗЖЕ (их подхватит следующая
-- пересборка). Поэтому расширяем условие до ('completed','scoring').
-- 'parsing' не включаем: там строки лежат как 'pending' и в выборку не идут.
--
-- Совместимость: сигнатура функции и все её выходные поля не меняются;
-- парная правка — app/scripts/db/buildClientReportLargeScoreRollup.js.

CREATE OR REPLACE FUNCTION public.rebuild_client_report_large_score_rollup_day(
  p_rollup_run_id uuid,
  p_job_id uuid,
  p_cohort_day date
)
RETURNS TABLE (
  source_count bigint,
  bucket_count bigint,
  max_cohort_at timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_client_user_id uuid;
  v_source_watermark timestamptz;
  v_day_from timestamptz;
  v_day_to timestamptz;
  v_source_count bigint := 0;
  v_bucket_count bigint := 0;
  v_max_cohort_at timestamptz;
BEGIN
  IF p_rollup_run_id IS NULL OR p_job_id IS NULL OR p_cohort_day IS NULL THEN
    RAISE EXCEPTION 'rollup run, job and cohort day are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT run.client_user_id, run.source_watermark
  INTO v_client_user_id, v_source_watermark
  FROM public.client_report_large_score_rollup_runs AS run
  JOIN public.large_score_jobs AS job
    ON job.id = p_job_id
   AND run.client_user_id = job.client_user_id
  WHERE run.id = p_rollup_run_id
    AND run.status = 'building'
    AND job.status IN ('completed', 'scoring')
  FOR UPDATE OF run;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollup run or eligible job not found'
      USING ERRCODE = '22023';
  END IF;

  v_day_from := p_cohort_day::timestamp AT TIME ZONE 'Europe/Moscow';
  v_day_to := (p_cohort_day + 1)::timestamp AT TIME ZONE 'Europe/Moscow';

  DELETE FROM public.client_report_large_score_rollup_buckets
  WHERE rollup_run_id = p_rollup_run_id
    AND client_user_id = v_client_user_id
    AND source_job_id = p_job_id
    AND cohort_day = p_cohort_day;

  WITH eligible AS MATERIALIZED (
    SELECT
      d.scored_at,
      CASE
        WHEN d.status = 'error' THEN 'error'
        ELSE public.client_report_score_code(cache.score)
      END AS score_code
    FROM public.large_score_domains AS d
    JOIN public.client_report_large_score_rollup_runs AS run
      ON run.id = p_rollup_run_id
     AND run.client_user_id = v_client_user_id
    LEFT JOIN public.mailganer_domain_scores AS cache
      ON cache.domain = lower(btrim(d.domain))
    WHERE d.job_id = p_job_id
      AND d.status IN ('scored', 'error')
      AND nullif(btrim(d.domain), '') IS NOT NULL
      AND d.scored_at >= v_day_from
      AND d.scored_at < v_day_to
      AND d.scored_at <= v_source_watermark
      AND NOT EXISTS (
        SELECT 1
        FROM public.client_pipeline_domain_snapshots AS exact_match
        WHERE exact_match.client_user_id = run.client_user_id
          AND NOT exact_match.legacy_inferred
          AND exact_match.source_kind = 'large_score_file'
          AND exact_match.source_job_id = p_job_id::text
          AND exact_match.source_row_id = d.id::text
      )
  ),
  source_stats AS (
    SELECT
      count(*)::bigint AS source_count,
      max(eligible.scored_at) AS max_cohort_at
    FROM eligible
  ),
  grouped AS (
    SELECT
      eligible.score_code,
      count(*)::bigint AS domain_count,
      max(eligible.scored_at) AS max_cohort_at
    FROM eligible
    GROUP BY eligible.score_code
  ),
  inserted AS (
    INSERT INTO public.client_report_large_score_rollup_buckets (
      rollup_run_id,
      client_user_id,
      source_job_id,
      cohort_day,
      score_code,
      domain_count,
      max_cohort_at
    )
    SELECT
      p_rollup_run_id,
      v_client_user_id,
      p_job_id,
      p_cohort_day,
      grouped.score_code,
      grouped.domain_count,
      grouped.max_cohort_at
    FROM grouped
    RETURNING domain_count
  )
  SELECT
    source_stats.source_count,
    coalesce(sum(inserted.domain_count), 0)::bigint,
    source_stats.max_cohort_at
  INTO v_source_count, v_bucket_count, v_max_cohort_at
  FROM source_stats
  LEFT JOIN inserted ON true
  GROUP BY source_stats.source_count, source_stats.max_cohort_at;

  IF v_source_count <> v_bucket_count THEN
    RAISE EXCEPTION 'large-score rollup count invariant failed'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.client_report_large_score_rollup_checkpoints (
    rollup_run_id,
    client_user_id,
    source_job_id,
    cohort_day,
    source_count,
    bucket_count,
    source_max_scored_at,
    rebuilt_at
  )
  VALUES (
    p_rollup_run_id,
    v_client_user_id,
    p_job_id,
    p_cohort_day,
    v_source_count,
    v_bucket_count,
    v_max_cohort_at,
    now()
  )
  ON CONFLICT (rollup_run_id, client_user_id, source_job_id, cohort_day) DO UPDATE
  SET source_count = EXCLUDED.source_count,
      bucket_count = EXCLUDED.bucket_count,
      source_max_scored_at = EXCLUDED.source_max_scored_at,
      rebuilt_at = EXCLUDED.rebuilt_at;

  RETURN QUERY
  SELECT v_source_count, v_bucket_count, v_max_cohort_at;
END;
$$;


REVOKE ALL ON FUNCTION public.rebuild_client_report_large_score_rollup_day(uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebuild_client_report_large_score_rollup_day(uuid, uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.rebuild_client_report_large_score_rollup_day(uuid, uuid, date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_client_report_large_score_rollup_day(uuid, uuid, date) TO service_role;
