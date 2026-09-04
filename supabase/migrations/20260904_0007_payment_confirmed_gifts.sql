-- Sergey confirmed these two Alina gifts as paid on their entered dates.
-- Move exactly 2016 RUB from reserve to fact; leave all other approvals alone.
DO $backfill$
DECLARE
  v_confirmer constant uuid := '66873c8c-ae56-4ab2-afa5-5e77dcda391d';
  v_owner constant uuid := '33dec504-e6e0-4b0a-bc59-dcf570c6ecc9';
  v_source constant text := '20260904_0007_payment_confirmed_gifts';
  v_targets constant jsonb := '[
    {"id":"348e88ae-dba8-4e6b-b27c-ede5502f0b4c","amount":401,"paid_on":"2026-09-04"},
    {"id":"65045cf0-a74e-4911-a023-5f7352a215c3","amount":1615,"paid_on":"2026-09-03"}
  ]'::jsonb;
  v_actor_name text;
  v_present integer;
  v_changed integer;
BEGIN
  SELECT coalesce(nullif(btrim(profile.full_name), ''), 'Сергей Лазуткин')
    INTO v_actor_name
    FROM public.profiles AS profile
   WHERE profile.id = v_confirmer
     FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE NOTICE '%: skipped, confirming requester is absent', v_source;
    RETURN;
  END IF;

  -- Match the existing row -> month lock order. Lock all target rows before
  -- taking the shared budget lock, so a concurrent transition cannot change a
  -- later target while we hold that month's lock. No triggers are disabled.
  PERFORM request.id
    FROM public.payment_requests AS request
    JOIN jsonb_to_recordset(v_targets)
      AS target(id uuid, amount numeric, paid_on date)
      ON target.id = request.id
   ORDER BY request.id
     FOR UPDATE OF request;
  GET DIAGNOSTICS v_present = ROW_COUNT;

  IF v_present = 0 THEN
    RAISE NOTICE '%: skipped, neither of the two confirmed requests exist', v_source;
    RETURN;
  END IF;

  PERFORM public.lock_payment_request_months(ARRAY[DATE '2026-09-01']);

  WITH targets AS (
    SELECT * FROM jsonb_to_recordset(v_targets)
      AS target(id uuid, amount numeric, paid_on date)
  ), changed AS (
    UPDATE public.payment_requests AS request
       SET status = 'paid',
           paid_on = target.paid_on,
           paid_on_source = 'entered',
           paid_by = v_confirmer,
           paid_at = now(),
           updated_at = now()
      FROM targets AS target
     WHERE request.id = target.id
       AND request.user_id = v_owner
       AND request.requester_user_id = v_owner
       AND request.budget_scope = 'general'
       AND request.expense_type = 'one_time'
       AND request.amount = target.amount
       AND request.cost_category IS NULL
       AND request.auto_payment_on IS NULL
       AND request.expected_payment_on = target.paid_on
       AND request.project_id IS NULL
       AND request.status = 'approved'
       AND request.paid_on IS NULL
       AND request.paid_on_source IS NULL
       AND request.paid_by IS NULL
       AND request.paid_at IS NULL
       AND target.paid_on <= (now() AT TIME ZONE 'Europe/Moscow')::date
    RETURNING request.id, request.amount, request.paid_on,
              request.budget_scope, request.cost_category
  )
  INSERT INTO public.payment_request_events (
    payment_request_id, actor_user_id, actor_name, event_type,
    from_status, to_status, metadata
  )
  SELECT changed.id, v_confirmer, v_actor_name, 'mark_paid', 'approved', 'paid',
         jsonb_build_object(
           'source', v_source,
           'confirmed_by', v_confirmer,
           'confirmed_on', DATE '2026-09-04',
           'old_paid_on', NULL,
           'new_paid_on', changed.paid_on,
           'amount', changed.amount,
           'budget_scope', changed.budget_scope,
           'cost_category', changed.cost_category
         )
    FROM changed;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  -- Only UPDATE RETURNING rows get events. Already paid, missing or drifted
  -- requests stay untouched, including on repeat execution.
  RAISE NOTICE '%: converted % of 2 confirmed requests; skipped % (missing, already paid or changed)',
    v_source, v_changed, 2 - v_changed;
END;
$backfill$;
