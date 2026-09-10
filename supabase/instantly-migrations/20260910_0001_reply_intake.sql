-- Operational Instantly DB only. Additive intake, not a qualification verdict
-- rewrite, queue purge, or historical replay. Existing recovery stays intact.
BEGIN;

CREATE TABLE IF NOT EXISTS public.instantly_reply_discovery (
  account_id text PRIMARY KEY CHECK (length(account_id) BETWEEN 1 AND 200),
  bootstrap_since timestamptz NOT NULL,
  sweep_since timestamptz NOT NULL,
  sweep_until timestamptz,
  sweep_cursor text,
  single_page_head boolean NOT NULL DEFAULT true,
  lease_token uuid,
  lease_until timestamptz,
  last_completed_at timestamptz,
  last_failure_at timestamptz,
  pages_staged bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sweep_since >= bootstrap_since),
  CHECK (sweep_until IS NULL OR sweep_until >= sweep_since)
);

CREATE TABLE IF NOT EXISTS public.instantly_reply_intake (
  account_id text NOT NULL REFERENCES public.instantly_reply_discovery(account_id),
  email_id text NOT NULL CHECK (length(email_id) BETWEEN 1 AND 500),
  campaign_id text NOT NULL,
  lead_email text,
  reply_timestamp timestamptz,
  email_payload jsonb NOT NULL CHECK (jsonb_typeof(email_payload) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'accepted')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, email_id)
);
CREATE INDEX IF NOT EXISTS instantly_reply_intake_due_idx
  ON public.instantly_reply_intake (account_id, available_at, created_at)
  WHERE state <> 'accepted';
CREATE INDEX IF NOT EXISTS instantly_reply_intake_email_idx
  ON public.instantly_reply_intake (email_id);
ALTER TABLE public.instantly_reply_discovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instantly_reply_intake ENABLE ROW LEVEL SECURITY;
-- grants-lint: no-service-role-grant public.instantly_reply_discovery — RPC-only lease/CAS protocol.
-- grants-lint: no-service-role-grant public.instantly_reply_intake — RPC-only durable staging/ACK protocol.

COMMENT ON TABLE public.instantly_reply_discovery IS
  'Account-scoped bounded creation-date sweep. Persist page BEFORE cursor in one transaction. Initial 48h source floor is fixed, later sweep watermarks overlap by one hour.';
COMMENT ON TABLE public.instantly_reply_intake IS
  'Every discovered linked inbound independently queued; accepted means a durable qualification/recovery row exists, not that it is a lead. Payload retained across crashes and technical failures.';

CREATE OR REPLACE FUNCTION public.claim_instantly_reply_discovery(p_account_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.instantly_reply_discovery%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_token uuid := gen_random_uuid();
BEGIN
  IF p_account_id IS NULL OR length(trim(p_account_id)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid reply discovery account';
  END IF;
  INSERT INTO public.instantly_reply_discovery(account_id, bootstrap_since, sweep_since)
  VALUES (p_account_id, v_now - interval '48 hours', v_now - interval '48 hours')
  ON CONFLICT (account_id) DO NOTHING;
  SELECT * INTO v_row FROM public.instantly_reply_discovery
    WHERE account_id = p_account_id FOR UPDATE;
  IF v_row.lease_until > v_now THEN RETURN jsonb_build_object('state', 'busy'); END IF;
  UPDATE public.instantly_reply_discovery SET
    sweep_until = coalesce(sweep_until, v_now), lease_token = v_token,
    lease_until = v_now + interval '3 minutes', updated_at = v_now
    WHERE account_id = p_account_id RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'claimed', 'lease_token', v_token,
    'bootstrap_since', v_row.bootstrap_since, 'sweep_since', v_row.sweep_since,
    'sweep_until', v_row.sweep_until, 'sweep_cursor', v_row.sweep_cursor,
    'single_page_head', v_row.single_page_head);
END;
$$;

CREATE OR REPLACE FUNCTION public.stage_instantly_reply_page(
  p_account_id text, p_lease_token uuid, p_items jsonb, p_is_head boolean,
  p_expected_cursor text, p_next_cursor text, p_sweep_complete boolean
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.instantly_reply_discovery%ROWTYPE;
  v_item jsonb;
  v_now timestamptz := clock_timestamp();
  v_staged integer := 0;
  v_inserted integer;
  v_reply_timestamp timestamptz;
BEGIN
  SELECT * INTO v_row FROM public.instantly_reply_discovery
    WHERE account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR p_lease_token IS NULL OR v_row.lease_token IS DISTINCT FROM p_lease_token
    OR v_row.lease_until IS NULL OR v_row.lease_until <= v_now THEN
    RETURN jsonb_build_object('state', 'lease_lost');
  END IF;
  IF p_is_head IS NULL OR p_sweep_complete IS NULL
    OR (NOT p_is_head AND v_row.sweep_cursor IS DISTINCT FROM p_expected_cursor)
    OR (p_sweep_complete AND (p_is_head OR p_next_cursor IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid reply discovery cursor';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) > 100
    OR octet_length(p_items::text) > 16777216 THEN
    RAISE EXCEPTION 'invalid reply discovery page';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF nullif(trim(v_item->>'email_id'), '') IS NULL
      OR nullif(trim(v_item->>'campaign_id'), '') IS NULL
      OR jsonb_typeof(v_item->'email_payload') IS DISTINCT FROM 'object'
      OR v_item->>'email_id' IS DISTINCT FROM v_item->'email_payload'->>'id'
      OR octet_length((v_item->'email_payload')::text) > 1048576 THEN
      RAISE EXCEPTION 'invalid reply discovery item';
    END IF;
    v_reply_timestamp := (v_item->>'reply_timestamp')::timestamptz;
    IF v_reply_timestamp IS NOT NULL AND v_reply_timestamp < v_row.bootstrap_since THEN
      CONTINUE; -- Historical import, not a newly received reply. Never touch existing qualifications.
    END IF;
    INSERT INTO public.instantly_reply_intake
      (account_id, email_id, campaign_id, lead_email, reply_timestamp, email_payload)
    VALUES (p_account_id, v_item->>'email_id', v_item->>'campaign_id',
      nullif(lower(trim(v_item->>'lead_email')), ''), v_reply_timestamp, v_item->'email_payload')
    ON CONFLICT (account_id, email_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    v_staged := v_staged + v_inserted;
  END LOOP;
  -- An insertion failure rolls back BOTH inbox writes and cursor progress.
  UPDATE public.instantly_reply_discovery SET
    sweep_cursor = CASE WHEN p_is_head THEN sweep_cursor ELSE p_next_cursor END,
    single_page_head = NOT p_is_head,
    sweep_since = CASE WHEN p_sweep_complete
      THEN greatest(bootstrap_since, sweep_until - interval '1 hour') ELSE sweep_since END,
    sweep_until = CASE WHEN p_sweep_complete THEN NULL ELSE sweep_until END,
    last_completed_at = CASE WHEN p_sweep_complete THEN v_now ELSE last_completed_at END,
    pages_staged = pages_staged + 1, lease_until = v_now + interval '3 minutes', updated_at = v_now
    WHERE account_id = p_account_id;
  RETURN jsonb_build_object('state', 'saved', 'staged', v_staged);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_instantly_reply_discovery(
  p_account_id text, p_lease_token uuid, p_failed boolean
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.instantly_reply_discovery SET lease_token = NULL, lease_until = NULL,
    last_failure_at = CASE WHEN p_failed THEN clock_timestamp() ELSE last_failure_at END,
    updated_at = clock_timestamp()
    WHERE account_id = p_account_id AND lease_token = p_lease_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'lease_lost'); END IF;
  RETURN jsonb_build_object('state', 'released');
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_instantly_reply_intake(p_account_ids text[], p_limit integer DEFAULT 2)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.instantly_reply_intake%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_limit integer := greatest(1, least(coalesce(p_limit, 2), 20));
  v_fresh_limit integer;
  v_count integer := 0;
  v_pass integer;
  v_token uuid;
  v_items jsonb := '[]'::jsonb;
BEGIN
  IF p_account_ids IS NULL OR cardinality(p_account_ids) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid intake account scope';
  END IF;
  v_fresh_limit := greatest(1, floor(v_limit * 0.75)::integer);
  -- Reserve a fresh lane and a backlog lane; unused capacity is shared. Claims
  -- last 30min so a bounded two-reply processor cannot be duplicated mid-call.
  FOR v_pass IN 1..3 LOOP
    FOR v_row IN SELECT q.* FROM public.instantly_reply_intake q
      WHERE q.account_id = ANY(p_account_ids) AND q.state <> 'accepted'
        AND q.available_at <= v_now
        AND (q.lease_until IS NULL OR q.lease_until <= v_now)
        AND (v_pass = 3 OR
          (v_pass = 1 AND q.reply_timestamp >= v_now - interval '2 hours') OR
          (v_pass = 2 AND (q.reply_timestamp IS NULL OR q.reply_timestamp < v_now - interval '2 hours')))
      ORDER BY q.created_at, q.account_id, q.email_id
      LIMIT CASE WHEN v_pass = 1 THEN v_fresh_limit ELSE v_limit - v_count END
      FOR UPDATE SKIP LOCKED
    LOOP
      v_token := gen_random_uuid();
      UPDATE public.instantly_reply_intake SET state = 'processing', attempts = attempts + 1,
        lease_token = v_token, lease_until = v_now + interval '30 minutes', updated_at = v_now
        WHERE account_id = v_row.account_id AND email_id = v_row.email_id
        RETURNING * INTO v_row;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'account_id', v_row.account_id, 'email_id', v_row.email_id,
        'lease_token', v_token, 'email_payload', v_row.email_payload, 'attempts', v_row.attempts));
      v_count := v_count + 1;
    END LOOP;
    EXIT WHEN v_count >= v_limit;
  END LOOP;
  RETURN jsonb_build_object('state', 'claimed', 'items', v_items);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_instantly_reply_intake(
  p_account_id text, p_email_id text, p_lease_token uuid, p_complete boolean,
  p_error_code text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.instantly_reply_intake%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_row FROM public.instantly_reply_intake
    WHERE account_id = p_account_id AND email_id = p_email_id FOR UPDATE;
  IF NOT FOUND OR p_lease_token IS NULL OR v_row.state <> 'processing'
    OR v_row.lease_token IS DISTINCT FROM p_lease_token
    OR v_row.lease_until IS NULL OR v_row.lease_until <= v_now THEN
    RETURN jsonb_build_object('state', 'lease_lost');
  END IF;
  IF p_complete IS TRUE THEN
    -- Provider email UUID is globally unique in the existing qualification
    -- schema (which has no account_id). Check sender as an additional fence;
    -- do NOT require campaign equality: ownership resolution may correct it.
    -- Any observed cross-account UUID collision fails closed, not against a
    -- different account's qualification. No qualification row is overwritten.
    IF EXISTS (SELECT 1 FROM public.instantly_reply_intake q
      WHERE q.email_id = p_email_id AND q.account_id <> p_account_id)
      OR NOT EXISTS (SELECT 1 FROM public.instantly_lead_qualifications q
        WHERE q.instantly_email_id::text = p_email_id
          AND (v_row.lead_email IS NULL OR lower(trim(q.lead_email)) = v_row.lead_email)) THEN
      RETURN jsonb_build_object('state', 'missing_qualification');
    END IF;
    UPDATE public.instantly_reply_intake SET state = 'accepted', accepted_at = v_now,
      lease_token = NULL, lease_until = NULL, last_error_code = NULL, updated_at = v_now
      WHERE account_id = p_account_id AND email_id = p_email_id;
    RETURN jsonb_build_object('state', 'accepted');
  END IF;
  UPDATE public.instantly_reply_intake SET state = 'pending', lease_token = NULL, lease_until = NULL,
    available_at = v_now + make_interval(secs => least(300, 15 * power(2, least(attempts, 5)))::integer),
    last_error_code = CASE WHEN p_error_code = ANY(ARRAY['provider_budget', 'timeout',
      'ownership_unresolved', 'storage_unavailable']) THEN p_error_code
      ELSE 'qualification_not_durably_saved' END, updated_at = v_now
    WHERE account_id = p_account_id AND email_id = p_email_id;
  RETURN jsonb_build_object('state', 'deferred');
END;
$$;

REVOKE ALL ON TABLE public.instantly_reply_discovery, public.instantly_reply_intake FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_instantly_reply_discovery(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stage_instantly_reply_page(text, uuid, jsonb, boolean, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_instantly_reply_discovery(text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_instantly_reply_intake(text[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_instantly_reply_intake(text, text, uuid, boolean, text) FROM PUBLIC;
DO $$
DECLARE v_role text; v_signature text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'instantly'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.instantly_reply_discovery, public.instantly_reply_intake FROM %I', v_role);
      FOREACH v_signature IN ARRAY ARRAY[
        'public.claim_instantly_reply_discovery(text)',
        'public.stage_instantly_reply_page(text, uuid, jsonb, boolean, text, text, boolean)',
        'public.release_instantly_reply_discovery(text, uuid, boolean)',
        'public.claim_instantly_reply_intake(text[], integer)',
        'public.finish_instantly_reply_intake(text, text, uuid, boolean, text)'
      ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_signature, v_role);
        IF v_role IN ('service_role', 'instantly') THEN
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_signature, v_role);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END;
$$;
COMMIT;
NOTIFY pgrst, 'reload schema';
