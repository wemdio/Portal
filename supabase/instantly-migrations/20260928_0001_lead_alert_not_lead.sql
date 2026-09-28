-- Allow an authorized specialist to reject the initial lead alert before a
-- handoff draft exists (including projects without a configured handoff).
-- The application rechecks the current project's manual mode and Telegram
-- actor/card. Only trusted backend roles can invoke this RPC.
CREATE OR REPLACE FUNCTION public.reject_instantly_lead_from_alert(
  p_qualification_id uuid, p_project_id uuid, p_telegram_id bigint,
  p_responsible_user_id uuid, p_chat_id bigint
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  q public.instantly_lead_qualifications%ROWTYPE;
  h public.instantly_pending_handoffs%ROWTYPE;
  inserted_id uuid;
BEGIN
  IF p_telegram_id IS NULL OR p_project_id IS NULL
     OR p_responsible_user_id IS NULL OR p_chat_id IS NULL THEN
    RETURN 'unavailable';
  END IF;
  SELECT * INTO q FROM public.instantly_lead_qualifications
    WHERE id = p_qualification_id;
  IF NOT FOUND OR q.qualified_project_id IS DISTINCT FROM p_project_id
     OR q.status IS DISTINCT FROM 'lead' OR q.queue_archived_at IS NOT NULL THEN
    RETURN 'unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM public.client_forwarded_leads WHERE qualification_id = q.id) THEN
    RETURN 'unavailable';
  END IF;

  -- This is a terminal rejection-only row, not a fabricated outgoing draft.
  -- Empty send fields cannot be used: status is never pending. The existing
  -- worker sees this row and stops; the existing board view hides its candidate.
  -- ON CONFLICT serializes against a worker materializing the real handoff.
  -- If that worker wins, use the established pending/send/edit row lock below.
  INSERT INTO public.instantly_pending_handoffs (
    qualification_id, campaign_id, draft_text, reply_to_uuid, eaccount,
    client_email, responsible_user_id, tg_chat_id, auto_send, status,
    rejected_at, rejected_by_telegram_id, rejection_snapshot
  ) VALUES (
    q.id, q.campaign_id, '', coalesce(to_jsonb(q)->>'instantly_email_id', ''),
    coalesce(to_jsonb(q)->>'eaccount', ''), '', p_responsible_user_id, p_chat_id,
    false, 'rejected', clock_timestamp(), p_telegram_id,
    jsonb_build_object(
      'decision', 'not_lead', 'source', 'lead_alert', 'qualification_id', q.id,
      'project_id', q.qualified_project_id, 'campaign_id', q.campaign_id,
      'campaign_name', q.campaign_name, 'lead_email', q.lead_email,
      'lead_name', q.lead_name, 'company_name', q.company_name,
      'reply_subject', q.reply_subject, 'reply_body', q.reply_body,
      'reply_timestamp', q.reply_timestamp, 'last_outbound_preview', q.last_outbound_preview,
      'ai_status', q.status, 'ai_reason', q.ai_reason,
      'ai_confidence', to_jsonb(q)->'ai_confidence',
      'board_candidate', (SELECT to_jsonb(r) FROM public.project_lead_board_rows r
        WHERE r.qualification_id = q.id)
    )
  ) ON CONFLICT (qualification_id) DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN RETURN 'rejected'; END IF;

  SELECT * INTO h FROM public.instantly_pending_handoffs
    WHERE qualification_id = p_qualification_id FOR UPDATE;
  IF NOT FOUND OR h.responsible_user_id IS DISTINCT FROM p_responsible_user_id
     OR h.tg_chat_id IS DISTINCT FROM p_chat_id THEN
    RETURN 'unavailable';
  END IF;
  -- Preserves the existing auto-send marker, sent/failed/claimed/edit guards,
  -- immutable rejection snapshot and idempotent repeated presses.
  RETURN public.reject_instantly_handoff(p_qualification_id, p_telegram_id);
END;
$$;

REVOKE ALL ON FUNCTION public.reject_instantly_lead_from_alert(uuid, uuid, bigint, uuid, bigint) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.reject_instantly_lead_from_alert(uuid, uuid, bigint, uuid, bigint) FROM %I', role_name);
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['instantly', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.reject_instantly_lead_from_alert(uuid, uuid, bigint, uuid, bigint) TO %I', role_name);
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
