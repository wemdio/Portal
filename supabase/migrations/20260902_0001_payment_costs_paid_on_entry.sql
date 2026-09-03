-- Manual company costs are entered after payment, so submission records fact.
-- Keep the RPC signature, atomic monthly cap/FX checks, idempotency and general
-- approval workflows intact. Existing rows are intentionally not reclassified.

create or replace function public.submit_payment_request_with_budget(
  p_idempotency_key uuid,
  p_department text,
  p_description text,
  p_amount numeric,
  p_project_id uuid,
  p_comment text,
  p_expense_type text,
  p_budget_scope text,
  p_cost_category text,
  p_expected_payment_on date,
  p_urgency text,
  p_document_url text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_month date := date_trunc('month', p_expected_payment_on)::date;
  v_submission_fingerprint text;
  v_existing public.payment_requests%rowtype;
  v_summary jsonb;
  v_remaining numeric;
  v_status text;
  v_approval_reason text;
  v_outcome text;
  v_request_id uuid;
begin
  if v_actor_id is null or not public.can_use_payment_requests() then
    raise exception 'payment_request_forbidden' using errcode = '42501';
  end if;
  if p_idempotency_key is null
     or p_department is null
     or p_department not in ('outreach', 'paid_traffic', 'accounting', 'sales')
     or p_expense_type is null
     or p_expense_type not in ('one_time', 'planned')
     or p_budget_scope is null
     or p_budget_scope not in ('general', 'costs')
     or (p_budget_scope = 'general' and p_cost_category is not null)
     or (
       p_budget_scope = 'costs'
       and coalesce(p_cost_category, '') not in ('instantly', 'email', 'bases', 'domains', 'other')
     )
     or p_urgency is null
     or p_urgency not in ('normal', 'urgent', 'critical')
     or p_expected_payment_on is null
     or p_amount is null
     or p_amount <= 0
     or p_amount > 9999999999.99
     or p_amount <> round(p_amount, 2)
     or char_length(btrim(coalesce(p_description, ''))) not between 1 and 500
     or (p_comment is not null and char_length(p_comment) > 5000)
     or (p_document_url is not null and (
       char_length(p_document_url) > 2000
       or p_document_url !~* '^https?://'
     ))
  then
    raise exception 'payment_request_invalid_input' using errcode = '22023';
  end if;
  if p_project_id is not null and not exists (
    select 1 from public.projects project where project.id = p_project_id
  ) then
    raise exception 'payment_request_project_not_found' using errcode = 'P0002';
  end if;

  select coalesce(nullif(btrim(actor.full_name), ''), 'Неизвестно')
    into v_actor_name
    from public.profiles actor
   where actor.id = v_actor_id;
  v_actor_name := coalesce(v_actor_name, 'Неизвестно');

  v_submission_fingerprint := encode(
    sha256(convert_to(jsonb_build_object(
      'department', p_department,
      'description', btrim(p_description),
      'amount', round(p_amount, 2)::text,
      'project_id', p_project_id,
      'comment', nullif(btrim(p_comment), ''),
      'expense_type', p_expense_type,
      'budget_scope', p_budget_scope,
      'cost_category', p_cost_category,
      'expected_payment_on', p_expected_payment_on,
      'urgency', p_urgency,
      'document_url', nullif(btrim(p_document_url), '')
    )::text, 'utf8')),
    'hex'
  );

  perform public.lock_payment_request_submission(v_actor_id, p_idempotency_key);

  select request.*
    into v_existing
    from public.payment_requests request
   where request.requester_user_id = v_actor_id
     and request.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.submission_fingerprint is distinct from v_submission_fingerprint then
      raise exception 'payment_request_idempotency_conflict' using errcode = '23505';
    end if;
    perform public.lock_payment_request_months(array[v_month]);
    return jsonb_build_object(
      'request', public.payment_request_api_record(v_existing.id),
      'summary', public.payment_request_month_summary(v_month),
      'outcome', case
        when v_existing.budget_scope = 'costs' and v_existing.status = 'paid' then 'recorded_paid'
        when v_existing.status = 'approved' then 'auto_approved'
        else 'approval_required'
      end
    );
  end if;

  -- Preserve retries of pre-change approved costs with a future expected date.
  -- Only a new paid entry must already have reached its actual payment date.
  if p_budget_scope = 'costs'
     and p_expected_payment_on > (now() at time zone 'Europe/Moscow')::date
  then
    raise exception 'payment_request_invalid_paid_date' using errcode = '22023';
  end if;

  perform public.lock_payment_request_months(array[v_month]);
  v_summary := public.payment_request_month_summary(v_month);

  if p_budget_scope = 'costs' then
    if coalesce((v_summary #>> '{costBudget,dataComplete}')::boolean, false) = false then
      raise exception 'payment_request_cost_budget_incomplete' using errcode = 'P0001';
    end if;
    v_remaining := coalesce((v_summary #>> '{costBudget,remaining}')::numeric, 0);
    if p_amount > v_remaining then
      raise exception 'payment_request_cost_limit_exceeded' using errcode = 'P0001';
    end if;
    -- A manual company cost records money already paid by its author. The
    -- supplied date is the actual payment date; there is no manager action.
    v_status := 'paid';
    v_approval_reason := null;
    v_outcome := 'recorded_paid';
  else
    v_remaining := (v_summary ->> 'remaining')::numeric;
    if p_expense_type = 'planned' then
      v_status := 'pending';
      v_approval_reason := 'planned';
      v_outcome := 'approval_required';
    elsif p_amount <= v_remaining then
      v_status := 'approved';
      v_approval_reason := null;
      v_outcome := 'auto_approved';
    else
      v_status := 'pending';
      v_approval_reason := 'limit_exceeded';
      v_outcome := 'approval_required';
    end if;
  end if;

  insert into public.payment_requests (
    user_id,
    requester_user_id,
    requester_name,
    department,
    description,
    amount,
    project_id,
    comment,
    expense_type,
    budget_scope,
    cost_category,
    expected_payment_on,
    urgency,
    document_url,
    status,
    approval_reason,
    decided_by,
    decided_at,
    decision_comment,
    paid_on,
    paid_on_source,
    paid_by,
    paid_at,
    idempotency_key,
    submission_fingerprint
  ) values (
    v_actor_id,
    v_actor_id,
    v_actor_name,
    p_department,
    btrim(p_description),
    p_amount,
    p_project_id,
    nullif(btrim(p_comment), ''),
    p_expense_type,
    p_budget_scope,
    p_cost_category,
    p_expected_payment_on,
    p_urgency,
    nullif(btrim(p_document_url), ''),
    v_status,
    v_approval_reason,
    null,
    null,
    null,
    case when v_status = 'paid' then p_expected_payment_on else null end,
    case when v_status = 'paid' then 'entered' else null end,
    case when v_status = 'paid' then v_actor_id else null end,
    case when v_status = 'paid' then now() else null end,
    p_idempotency_key,
    v_submission_fingerprint
  ) returning id into v_request_id;

  insert into public.payment_request_events (
    payment_request_id,
    actor_user_id,
    actor_name,
    event_type,
    from_status,
    to_status,
    metadata
  ) values (
    v_request_id,
    v_actor_id,
    v_actor_name,
    case
      when v_outcome = 'recorded_paid' then 'submitted_paid'
      when v_outcome = 'auto_approved' then 'submitted_auto_approved'
      else 'submitted_for_approval'
    end,
    null,
    v_status,
    jsonb_build_object(
      'expense_type', p_expense_type,
      'budget_scope', p_budget_scope,
      'cost_category', p_cost_category,
      'expected_payment_on', p_expected_payment_on,
      'approval_reason', v_approval_reason
    ) || case when v_status = 'paid' then jsonb_build_object(
      'paid_on', p_expected_payment_on,
      'paid_on_source', 'entered'
    ) else '{}'::jsonb end
  );

  v_summary := public.payment_request_month_summary(v_month);
  return jsonb_build_object(
    'request', public.payment_request_api_record(v_request_id),
    'summary', v_summary,
    'outcome', v_outcome
  );
end;
$$;

revoke all on function public.submit_payment_request_with_budget(uuid, text, text, numeric, uuid, text, text, text, text, date, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_payment_request_with_budget(uuid, text, text, numeric, uuid, text, text, text, text, date, text, text)
  to authenticated;
