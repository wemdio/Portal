-- Safe, client-specific activation for the previously staged large-score
-- report rollup. The legacy summary RPC remains unchanged and is the runtime
-- fallback whenever no selector exists or the optimized call fails.

-- grants-lint: no-service-role-grant public.client_report_large_score_rollup_activations — sealed on purpose: no role gets direct access
-- Direct table access is revoked from every role below. service_role reads
-- activations only through the SECURITY DEFINER function
-- client_report_large_score_rollup_active_run(uuid); writes go through the
-- operator-only activate/deactivate functions. Granting this table to
-- service_role would let the app forge an activation without the "verified
-- ready run" check that this migration exists to enforce.
CREATE TABLE IF NOT EXISTS public.client_report_large_score_rollup_activations (
  client_user_id uuid NOT NULL,
  rollup_run_id uuid NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_user_id),
  FOREIGN KEY (rollup_run_id, client_user_id)
    REFERENCES public.client_report_large_score_rollup_runs (id, client_user_id)
    ON DELETE RESTRICT
);

ALTER TABLE public.client_report_large_score_rollup_activations
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.client_report_large_score_rollup_activations FROM PUBLIC;
REVOKE ALL ON TABLE public.client_report_large_score_rollup_activations FROM anon;
REVOKE ALL ON TABLE public.client_report_large_score_rollup_activations FROM authenticated;
REVOKE ALL ON TABLE public.client_report_large_score_rollup_activations FROM service_role;

-- Row triggers cannot observe TRUNCATE. The staging migration granted ALL to
-- service_role, so remove this one unguardable privilege explicitly.
REVOKE TRUNCATE ON TABLE public.client_report_large_score_rollup_buckets FROM service_role;
REVOKE TRUNCATE ON TABLE public.client_report_large_score_rollup_checkpoints FROM service_role;

-- Direct child writes are guarded even for service_role. The trigger also
-- rejects changing ownership/run ids during an UPDATE.
CREATE OR REPLACE FUNCTION public.guard_client_report_large_score_rollup_child()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rollup_run_id uuid;
  v_client_user_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_rollup_run_id := NEW.rollup_run_id;
    v_client_user_id := NEW.client_user_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.rollup_run_id IS DISTINCT FROM NEW.rollup_run_id
       OR OLD.client_user_id IS DISTINCT FROM NEW.client_user_id
    THEN
      RAISE EXCEPTION 'large-score rollup child ownership is immutable'
        USING ERRCODE = '55000';
    END IF;
    v_rollup_run_id := NEW.rollup_run_id;
    v_client_user_id := NEW.client_user_id;
  ELSIF TG_OP = 'DELETE' THEN
    v_rollup_run_id := OLD.rollup_run_id;
    v_client_user_id := OLD.client_user_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.client_report_large_score_rollup_runs AS run
    WHERE run.id = v_rollup_run_id
      AND run.client_user_id = v_client_user_id
      AND run.status = 'building'
  ) THEN
    RAISE EXCEPTION 'large-score rollup children are writable only while building'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_client_report_large_score_rollup_buckets
  ON public.client_report_large_score_rollup_buckets;
CREATE TRIGGER trg_guard_client_report_large_score_rollup_buckets
BEFORE INSERT OR UPDATE OR DELETE ON public.client_report_large_score_rollup_buckets
FOR EACH ROW EXECUTE FUNCTION public.guard_client_report_large_score_rollup_child();

DROP TRIGGER IF EXISTS trg_guard_client_report_large_score_rollup_checkpoints
  ON public.client_report_large_score_rollup_checkpoints;
CREATE TRIGGER trg_guard_client_report_large_score_rollup_checkpoints
BEFORE INSERT OR UPDATE OR DELETE ON public.client_report_large_score_rollup_checkpoints
FOR EACH ROW EXECUTE FUNCTION public.guard_client_report_large_score_rollup_child();

REVOKE ALL ON FUNCTION public.guard_client_report_large_score_rollup_child() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_client_report_large_score_rollup_child() FROM anon;
REVOKE ALL ON FUNCTION public.guard_client_report_large_score_rollup_child() FROM authenticated;

-- Replace the existing parent guard only to make deletion semantics explicit.
-- Terminal runs cannot be deleted. Building runs delete their children first,
-- allowing the child write guard to validate the cascade safely.
CREATE OR REPLACE FUNCTION public.guard_client_report_large_score_rollup_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_checkpoint_count bigint;
  v_checkpoint_rows bigint;
  v_bucket_rows bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'building' THEN
      RAISE EXCEPTION 'large-score rollup run is terminal'
        USING ERRCODE = '55000';
    END IF;
    DELETE FROM public.client_report_large_score_rollup_checkpoints
    WHERE rollup_run_id = OLD.id AND client_user_id = OLD.client_user_id;
    DELETE FROM public.client_report_large_score_rollup_buckets
    WHERE rollup_run_id = OLD.id AND client_user_id = OLD.client_user_id;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'large-score rollup run is terminal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'ready' THEN
    SELECT count(*)::bigint, coalesce(sum(checkpoint.source_count), 0)::bigint
    INTO v_checkpoint_count, v_checkpoint_rows
    FROM public.client_report_large_score_rollup_checkpoints AS checkpoint
    WHERE checkpoint.rollup_run_id = NEW.id
      AND checkpoint.client_user_id = NEW.client_user_id;

    SELECT coalesce(sum(bucket.domain_count), 0)::bigint
    INTO v_bucket_rows
    FROM public.client_report_large_score_rollup_buckets AS bucket
    WHERE bucket.rollup_run_id = NEW.id
      AND bucket.client_user_id = NEW.client_user_id;

    IF v_checkpoint_count <> NEW.source_job_days
       OR v_checkpoint_rows <> NEW.source_rows
       OR v_bucket_rows <> NEW.source_rows
    THEN
      RAISE EXCEPTION 'large-score rollup completeness check failed'
        USING ERRCODE = '23514';
    END IF;

    NEW.ready_at := coalesce(NEW.ready_at, now());
    NEW.error_message := NULL;
    NEW.validation := coalesce(NEW.validation, '{}'::jsonb) || jsonb_build_object(
      'checkpoint_count', v_checkpoint_count,
      'source_rows', v_checkpoint_rows,
      'bucket_rows', v_bucket_rows,
      'validated_at', now()
    );
  ELSIF NEW.status = 'failed' THEN
    NEW.ready_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_client_report_large_score_rollup_run
  ON public.client_report_large_score_rollup_runs;
CREATE TRIGGER trg_guard_client_report_large_score_rollup_run
BEFORE INSERT OR UPDATE OR DELETE ON public.client_report_large_score_rollup_runs
FOR EACH ROW EXECUTE FUNCTION public.guard_client_report_large_score_rollup_run();

-- Verify the complete persisted operator report again at activation time. All
-- equality checks are against the immutable ready run's own baseline.
CREATE OR REPLACE FUNCTION public.activate_client_report_large_score_rollup(
  p_client_user_id uuid,
  p_rollup_run_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_run public.client_report_large_score_rollup_runs%ROWTYPE;
  v_validation jsonb;
BEGIN
  IF p_client_user_id IS NULL OR p_rollup_run_id IS NULL THEN
    RAISE EXCEPTION 'client and rollup run are required' USING ERRCODE = '22023';
  END IF;

  SELECT run.* INTO v_run
  FROM public.client_report_large_score_rollup_runs AS run
  WHERE run.id = p_rollup_run_id
    AND run.client_user_id = p_client_user_id
    AND run.status = 'ready'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verified ready rollup run not found for client'
      USING ERRCODE = '22023';
  END IF;

  v_validation := v_run.validation;
  IF (
    v_validation ? 'validated_at'
    AND v_validation ? 'sourceRows'
    AND v_validation ? 'rollupRows'
    AND v_validation ? 'baselineSourceRows'
    AND v_validation ? 'sourceWatermarkAtStart'
    AND v_validation ? 'sourceWatermarkAtVerify'
    AND v_validation ? 'rollupWatermark'
    AND v_validation ? 'sourceFingerprintAtStart'
    AND v_validation ? 'sourceFingerprintAtVerify'
    AND v_validation ? 'sourceBuckets'
    AND v_validation ? 'rollupBuckets'
    AND v_validation ? 'runStatus'
    AND v_validation ? 'expectedJobDays'
    AND v_validation ? 'checkpointJobDays'
    AND v_validation ? 'baselineJobDays'
    AND v_validation ? 'invalidCheckpointRows'
    AND v_validation ? 'duplicateBucketKeys'
    AND v_validation ? 'mismatchedBucketKeys'
    AND v_validation ? 'checkpoint_count'
    AND v_validation ? 'source_rows'
    AND v_validation ? 'bucket_rows'
    AND nullif(v_validation->>'validated_at', '') IS NOT NULL
    AND jsonb_typeof(v_validation->'sourceBuckets') = 'object'
    AND jsonb_typeof(v_validation->'rollupBuckets') = 'object'
    AND v_validation->>'runStatus' = 'building'
    AND (v_validation->>'sourceRows')::bigint = v_run.source_rows
    AND (v_validation->>'rollupRows')::bigint = v_run.source_rows
    AND (v_validation->>'baselineSourceRows')::bigint = v_run.source_rows
    AND (v_validation->>'sourceWatermarkAtStart')::timestamptz = v_run.source_watermark
    AND v_validation->>'sourceWatermarkAtStart' = v_validation->>'sourceWatermarkAtVerify'
    AND v_validation->>'sourceWatermarkAtVerify' = v_validation->>'rollupWatermark'
    AND v_validation->>'sourceFingerprintAtStart' = v_run.source_fingerprint
    AND v_validation->>'sourceFingerprintAtVerify' = v_run.source_fingerprint
    AND v_validation->'sourceBuckets' = v_validation->'rollupBuckets'
    AND (v_validation->>'expectedJobDays')::bigint = v_run.source_job_days
    AND (v_validation->>'checkpointJobDays')::bigint = v_run.source_job_days
    AND (v_validation->>'baselineJobDays')::bigint = v_run.source_job_days
    AND (v_validation->>'invalidCheckpointRows')::bigint = 0
    AND (v_validation->>'duplicateBucketKeys')::bigint = 0
    AND (v_validation->>'mismatchedBucketKeys')::bigint = 0
    AND (v_validation->>'checkpoint_count')::bigint = v_run.source_job_days
    AND (v_validation->>'source_rows')::bigint = v_run.source_rows
    AND (v_validation->>'bucket_rows')::bigint = v_run.source_rows
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'verified ready rollup run not found for client'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.client_report_large_score_rollup_activations (
    client_user_id, rollup_run_id, activated_at
  ) VALUES (p_client_user_id, p_rollup_run_id, now())
  ON CONFLICT (client_user_id) DO UPDATE
  SET rollup_run_id = EXCLUDED.rollup_run_id,
      activated_at = EXCLUDED.activated_at;
  RETURN p_rollup_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.deactivate_client_report_large_score_rollup(
  p_client_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_removed uuid;
BEGIN
  DELETE FROM public.client_report_large_score_rollup_activations
  WHERE client_user_id = p_client_user_id
  RETURNING rollup_run_id INTO v_removed;
  RETURN v_removed;
END;
$$;

CREATE OR REPLACE FUNCTION public.client_report_large_score_rollup_active_run(
  p_client_user_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT activation.rollup_run_id
  FROM public.client_report_large_score_rollup_activations AS activation
  JOIN public.client_report_large_score_rollup_runs AS run
    ON run.id = activation.rollup_run_id
   AND run.client_user_id = activation.client_user_id
   AND run.status = 'ready'
  WHERE activation.client_user_id = p_client_user_id
$$;

REVOKE ALL ON FUNCTION public.activate_client_report_large_score_rollup(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_client_report_large_score_rollup(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.activate_client_report_large_score_rollup(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.activate_client_report_large_score_rollup(uuid, uuid) FROM service_role;
REVOKE ALL ON FUNCTION public.deactivate_client_report_large_score_rollup(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deactivate_client_report_large_score_rollup(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.deactivate_client_report_large_score_rollup(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.deactivate_client_report_large_score_rollup(uuid) FROM service_role;
REVOKE ALL ON FUNCTION public.client_report_large_score_rollup_active_run(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.client_report_large_score_rollup_active_run(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.client_report_large_score_rollup_active_run(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.client_report_large_score_rollup_active_run(uuid) TO service_role;
