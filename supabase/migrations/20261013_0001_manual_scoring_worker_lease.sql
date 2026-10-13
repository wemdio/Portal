-- Prepared only: requires an explicitly approved migration/deploy.
-- No backfill/requeue of historical processing or failed runs.
ALTER TABLE public.client_manual_score_runs
  ADD COLUMN IF NOT EXISTS worker_token uuid,
  ADD COLUMN IF NOT EXISTS worker_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS worker_phase text CHECK (worker_phase IN ('scoring', 'routing'));

-- A lost HTTP response must be retried with the SAME token. Serialize claims
-- globally: two workers must not start different runs at the same time.
CREATE OR REPLACE FUNCTION public.claim_manual_score_run(p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.client_manual_score_runs%ROWTYPE;
BEGIN
  IF p_token IS NULL THEN RAISE EXCEPTION 'Worker token required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('manual-scoring-worker', 0));
  SELECT * INTO r FROM public.client_manual_score_runs
    WHERE status = 'processing' AND worker_token = p_token FOR UPDATE;
  IF FOUND THEN
    UPDATE public.client_manual_score_runs SET worker_lease_until = clock_timestamp() + interval '5 minutes'
      WHERE id = r.id RETURNING * INTO r;
    RETURN to_jsonb(r);
  END IF;
  -- Expired routing is deliberately NOT reclaimed: an external append may
  -- have committed without a durable identity-complete receipt.
  IF EXISTS (SELECT 1 FROM public.client_manual_score_runs
      WHERE status = 'processing' AND worker_token IS NOT NULL
        AND (worker_lease_until > clock_timestamp() OR worker_phase = 'routing')) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO r FROM public.client_manual_score_runs
    WHERE (status = 'pending' AND unique_count > 0 AND unique_count = (
      SELECT count(*) FROM public.client_manual_score_rows WHERE run_id = client_manual_score_runs.id
    )) OR (status = 'processing' AND worker_token IS NOT NULL
      AND worker_phase = 'scoring' AND worker_lease_until <= clock_timestamp())
    ORDER BY started_at, id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.client_manual_score_runs SET status = 'processing', worker_token = p_token,
      worker_lease_until = clock_timestamp() + interval '5 minutes', worker_phase = 'scoring'
    WHERE id = r.id RETURNING * INTO r;
  RETURN to_jsonb(r);
END;
$$;

-- Run writes and lease transitions use one locked, token-fenced transaction.
CREATE OR REPLACE FUNCTION public.manual_score_lease_action(
  p_run_id uuid, p_token uuid, p_action text, p_patch jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.client_manual_score_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.client_manual_score_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'processing' OR r.worker_token IS DISTINCT FROM p_token
      OR r.worker_lease_until IS NULL OR r.worker_lease_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'Manual scoring lease lost' USING ERRCODE = 'P0001';
  END IF;
  IF p_action = 'renew' THEN
    UPDATE public.client_manual_score_runs SET worker_lease_until = clock_timestamp() + interval '5 minutes'
      WHERE id = p_run_id RETURNING * INTO r;
  ELSIF p_action = 'routing' THEN
    UPDATE public.client_manual_score_runs SET worker_phase = 'routing',
      worker_lease_until = clock_timestamp() + interval '5 minutes'
      WHERE id = p_run_id RETURNING * INTO r;
  ELSIF p_action = 'release' THEN
    IF r.worker_phase IS DISTINCT FROM 'scoring' THEN RAISE EXCEPTION 'Cannot requeue an uncertain routing phase'; END IF;
    UPDATE public.client_manual_score_runs SET status = 'pending', worker_token = NULL,
      worker_lease_until = NULL, worker_phase = NULL WHERE id = p_run_id RETURNING * INTO r;
  ELSIF p_action = 'update' THEN
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_patch) k WHERE k NOT IN
        ('status', 'processed_count', 'finished_at', 'error_message', 'bucket_storage_count',
         'bucket_medium_count', 'bucket_high_count', 'bucket_top_count')) THEN
      RAISE EXCEPTION 'Invalid manual run patch';
    END IF;
    IF p_patch ? 'status' AND p_patch->>'status' NOT IN ('processing', 'completed', 'failed') THEN
      RAISE EXCEPTION 'Invalid manual run transition';
    END IF;
    IF p_patch->>'status' = 'completed' AND (r.unique_count <= 0 OR r.unique_count <> (
      SELECT count(*) FROM public.client_manual_score_rows WHERE run_id = p_run_id
    ) OR EXISTS (
      SELECT 1 FROM public.client_manual_score_rows WHERE run_id = p_run_id AND bucket IS NULL
    )) THEN RAISE EXCEPTION 'Cannot complete a manual run with missing or unsaved rows'; END IF;
    UPDATE public.client_manual_score_runs SET
      status = coalesce(p_patch->>'status', status),
      processed_count = CASE WHEN p_patch ? 'processed_count' THEN (p_patch->>'processed_count')::integer ELSE processed_count END,
      finished_at = CASE WHEN p_patch ? 'finished_at' THEN (p_patch->>'finished_at')::timestamptz ELSE finished_at END,
      error_message = CASE WHEN p_patch ? 'error_message' THEN p_patch->>'error_message' ELSE error_message END,
      bucket_storage_count = CASE WHEN p_patch ? 'bucket_storage_count' THEN (p_patch->>'bucket_storage_count')::integer ELSE bucket_storage_count END,
      bucket_medium_count = CASE WHEN p_patch ? 'bucket_medium_count' THEN (p_patch->>'bucket_medium_count')::integer ELSE bucket_medium_count END,
      bucket_high_count = CASE WHEN p_patch ? 'bucket_high_count' THEN (p_patch->>'bucket_high_count')::integer ELSE bucket_high_count END,
      bucket_top_count = CASE WHEN p_patch ? 'bucket_top_count' THEN (p_patch->>'bucket_top_count')::integer ELSE bucket_top_count END,
      worker_token = CASE WHEN p_patch->>'status' IN ('completed', 'failed') THEN NULL ELSE worker_token END,
      worker_lease_until = CASE WHEN p_patch->>'status' IN ('completed', 'failed') THEN NULL ELSE worker_lease_until END,
      worker_phase = CASE WHEN p_patch->>'status' IN ('completed', 'failed') THEN NULL ELSE worker_phase END
    WHERE id = p_run_id RETURNING * INTO r;
  ELSE RAISE EXCEPTION 'Unknown manual lease action';
  END IF;
  RETURN to_jsonb(r);
END;
$$;

-- The parent lock fences row persistence atomically against reclaim. CAS
-- preserves every existing scoring/email/processed_at result on retry.
CREATE OR REPLACE FUNCTION public.save_manual_score_row(
  p_run_id uuid, p_token uuid, p_row_id bigint, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.client_manual_score_runs%ROWTYPE; saved public.client_manual_score_rows%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.client_manual_score_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'processing' OR r.worker_token IS DISTINCT FROM p_token
      OR r.worker_lease_until IS NULL OR r.worker_lease_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'Manual scoring lease lost' USING ERRCODE = 'P0001';
  END IF;
  IF r.worker_phase IS DISTINCT FROM 'scoring' OR p_payload->>'bucket' IS NULL OR p_payload->>'processed_at' IS NULL THEN
    RAISE EXCEPTION 'Invalid manual scoring row write';
  END IF;
  UPDATE public.client_manual_score_rows SET
    domain = p_payload->>'domain', score = (p_payload->>'score')::numeric,
    rating = p_payload->>'rating', spf = p_payload->>'spf', email = p_payload->>'email',
    email_validation_status = p_payload->>'email_validation_status', email2 = p_payload->>'email2',
    email2_validation_status = p_payload->>'email2_validation_status', bucket = p_payload->>'bucket',
    error_message = p_payload->>'error_message', scraped_name = p_payload->>'scraped_name',
    processed_at = (p_payload->>'processed_at')::timestamptz
    WHERE id = p_row_id AND run_id = p_run_id AND bucket IS NULL RETURNING * INTO saved;
  IF NOT FOUND THEN
    SELECT * INTO saved FROM public.client_manual_score_rows WHERE id = p_row_id AND run_id = p_run_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Manual scoring row missing'; END IF;
  END IF;
  RETURN to_jsonb(saved);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_manual_score_run(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.manual_score_lease_action(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_manual_score_row(uuid, uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_manual_score_run(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.manual_score_lease_action(uuid, uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_manual_score_row(uuid, uuid, bigint, jsonb) TO service_role;
