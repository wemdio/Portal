-- The requester confirmed on 2026-09-03 that these six manual costs were
-- already paid on their entered dates (107,128 RUB total). This is a targeted
-- correction, not a rule for reclassifying other historical approved requests.
-- Both reserve and fact stay in September, so total budget usage is unchanged.
DO $backfill$
DECLARE
  v_confirmer constant uuid := '66873c8c-ae56-4ab2-afa5-5e77dcda391d';
  v_source constant text := '20260903_0002_payment_costs_confirmed_paid_backfill';
  v_targets constant jsonb := '[
    {"id":"7b296854-38ef-4aac-9ef5-74968cba00d5","amount":21457,"paid_on":"2026-09-01","category":"instantly"},
    {"id":"f0c99996-109a-4913-8c84-f290c5207cfa","amount":850,"paid_on":"2026-09-02","category":"domains"},
    {"id":"7c580e2b-dda6-433e-b2d9-2e01c29504f9","amount":71673,"paid_on":"2026-09-02","category":"instantly"},
    {"id":"efc5c8b5-9d2e-4e11-a327-be98e7278ba4","amount":4511,"paid_on":"2026-09-02","category":"other"},
    {"id":"9ad21d74-529e-4d8a-993b-77ebd3fa5123","amount":6983,"paid_on":"2026-09-02","category":"instantly"},
    {"id":"1f8f2445-46ba-4735-aa09-32d646daaae8","amount":1654,"paid_on":"2026-09-03","category":"domains"}
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
      AS target(id uuid, amount numeric, paid_on date, category text)
      ON target.id = request.id
   ORDER BY request.id
     FOR UPDATE OF request;
  GET DIAGNOSTICS v_present = ROW_COUNT;

  IF v_present = 0 THEN
    RAISE NOTICE '%: skipped, none of the six confirmed requests exist', v_source;
    RETURN;
  END IF;

  PERFORM public.lock_payment_request_months(ARRAY[DATE '2026-09-01']);

  WITH targets AS (
    SELECT * FROM jsonb_to_recordset(v_targets)
      AS target(id uuid, amount numeric, paid_on date, category text)
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
       AND request.user_id = v_confirmer
       AND request.requester_user_id = v_confirmer
       AND request.budget_scope = 'costs'
       AND request.expense_type = 'one_time'
       AND request.amount = target.amount
       AND request.cost_category = target.category
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
           'confirmed_on', DATE '2026-09-03',
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
  RAISE NOTICE '%: converted % of 6 confirmed requests; skipped % (missing, already paid or changed)',
    v_source, v_changed, 6 - v_changed;
END;
$backfill$;
