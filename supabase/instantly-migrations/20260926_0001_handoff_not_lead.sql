-- Manual handoffs are internal candidates until the specialist sends them.
-- Keep source material for feedback, but expose only published rows to guests.
ALTER TABLE public.project_lead_board_rows
  ADD COLUMN IF NOT EXISTS specialist_review_required boolean NOT NULL DEFAULT false;

ALTER TABLE public.instantly_pending_handoffs
  DROP CONSTRAINT IF EXISTS instantly_pending_handoffs_status_check;
ALTER TABLE public.instantly_pending_handoffs
  ADD CONSTRAINT instantly_pending_handoffs_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'rejected')),
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by_telegram_id bigint,
  ADD COLUMN IF NOT EXISTS rejection_snapshot jsonb;

COMMENT ON COLUMN public.instantly_pending_handoffs.rejection_snapshot IS
  'Internal specialist feedback: original AI verdict, reply and board candidate at the moment of rejection. Never returned by the public board API.';

-- An updatable filtered view also fences PATCH/DELETE by guessed hidden row ID.
-- CHECK OPTION prevents a guest edit from making a row invisible or publishing
-- a review candidate. API field allowlists never accept qualification/review IDs.
-- The stored flag covers the interval BEFORE the handoff card is materialized;
-- the handoff check also covers historical manual cards created before rollout.
CREATE OR REPLACE VIEW public.project_client_lead_board_rows
WITH (security_barrier = true) AS
SELECT r.* FROM public.project_lead_board_rows r
WHERE (
  NOT r.specialist_review_required
  OR EXISTS (
    SELECT 1 FROM public.instantly_pending_handoffs h
    WHERE h.qualification_id = r.qualification_id AND h.status = 'sent'
  )
)
AND NOT EXISTS (
  SELECT 1 FROM public.instantly_pending_handoffs h
  WHERE h.qualification_id = r.qualification_id
    AND (h.status = 'rejected' OR (
      h.auto_send = false
      AND coalesce(h.error_message, '') NOT LIKE '[auto_send]%'
      AND h.status <> 'sent'
    ))
)
WITH LOCAL CHECK OPTION;

CREATE OR REPLACE FUNCTION public.reject_instantly_handoff(
  p_qualification_id uuid, p_telegram_id bigint
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  h public.instantly_pending_handoffs%ROWTYPE;
  q public.instantly_lead_qualifications%ROWTYPE;
BEGIN
  IF p_telegram_id IS NULL THEN RETURN 'unavailable'; END IF;
  -- Send/edit use UPDATE ... WHERE status='pending' on this exact row too.
  -- Row locking makes only one decision win, including a concurrent webhook.
  SELECT * INTO h FROM public.instantly_pending_handoffs
    WHERE qualification_id = p_qualification_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF;
  IF h.status = 'rejected' THEN RETURN 'already_rejected'; END IF;
  IF h.status <> 'pending' OR h.auto_send IS DISTINCT FROM false
     OR coalesce(h.error_message, '') LIKE '[auto_send]%'
     OR h.manual_send_claimed_at IS NOT NULL OR h.edit_token IS NOT NULL THEN
    RETURN 'unavailable';
  END IF;
  SELECT * INTO q FROM public.instantly_lead_qualifications WHERE id = p_qualification_id;
  IF NOT FOUND OR q.status <> 'lead' OR q.queue_archived_at IS NOT NULL THEN
    RETURN 'unavailable';
  END IF;
  UPDATE public.instantly_pending_handoffs SET
    status = 'rejected', rejected_at = clock_timestamp(),
    rejected_by_telegram_id = p_telegram_id,
    rejection_snapshot = jsonb_build_object(
      'decision', 'not_lead', 'qualification_id', q.id,
      'project_id', q.qualified_project_id, 'campaign_id', q.campaign_id,
      'campaign_name', q.campaign_name, 'lead_email', q.lead_email,
      'lead_name', q.lead_name, 'company_name', q.company_name,
      'reply_subject', q.reply_subject, 'reply_body', q.reply_body,
      'reply_timestamp', q.reply_timestamp, 'last_outbound_preview', q.last_outbound_preview,
      'ai_status', q.status, 'ai_reason', q.ai_reason,
      'ai_confidence', to_jsonb(q)->'ai_confidence',
      'draft_text', h.draft_text,
      'board_candidate', (SELECT to_jsonb(r) FROM public.project_lead_board_rows r
        WHERE r.qualification_id = p_qualification_id)
    )
    WHERE id = h.id;
  RETURN 'rejected';
END;
$$;

REVOKE ALL ON public.project_client_lead_board_rows FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_instantly_handoff(uuid, bigint) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON public.project_client_lead_board_rows FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION public.reject_instantly_handoff(uuid, bigint) FROM %I', role_name);
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['instantly', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_client_lead_board_rows TO %I', role_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.reject_instantly_handoff(uuid, bigint) TO %I', role_name);
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
