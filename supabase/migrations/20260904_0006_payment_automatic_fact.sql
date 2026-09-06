-- General expenses become fact when approved and their entered payment date is due.
-- Future automatic payments keep an explicit authorization. Reads derive their
-- due status using one Moscow date; no GET writes, worker, or mass legacy update.
alter table public.payment_requests
  add column if not exists auto_payment_on date,
  add column if not exists auto_payment_by uuid references public.profiles(id) on delete set null,
  add column if not exists auto_payment_authorized_at timestamptz;

create or replace function public.payment_request_today()
returns date language sql stable set search_path = ''
as $$ select (now() at time zone 'Europe/Moscow')::date $$;

create or replace function public.payment_request_effective(p_request public.payment_requests)
returns public.payment_requests
language plpgsql stable set search_path = ''
as $$
begin
  if p_request.status = 'approved'
     and p_request.budget_scope = 'general'
     and p_request.auto_payment_on <= public.payment_request_today()
  then
    p_request.status := 'paid';
    p_request.paid_on := p_request.auto_payment_on;
    p_request.paid_on_source := 'entered';
    p_request.paid_by := p_request.auto_payment_by;
    -- Recognition time by the agreed rule, not a claim of a bank callback.
    p_request.paid_at := p_request.auto_payment_on::timestamp at time zone 'Europe/Moscow';
  end if;
  return p_request;
end;
$$;

create or replace function public.payment_request_approved_status(p_date date)
returns text language sql stable set search_path = ''
as $$ select case when p_date <= public.payment_request_today() then 'paid' else 'approved' end $$;

revoke all on function public.payment_request_today() from public, anon, authenticated;
revoke all on function public.payment_request_effective(public.payment_requests) from public, anon, authenticated;
revoke all on function public.payment_request_approved_status(date) from public, anon, authenticated;


create or replace function public.payment_request_month_summary(p_month date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_next date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_today date := public.payment_request_today();
  v_limit numeric := public.payment_request_month_limit(p_month);
  v_cost_limit numeric := public.payment_request_cost_month_limit(p_month);
  v_paid_one_time numeric := 0;
  v_reserved_one_time numeric := 0;
  v_paid_all numeric := 0;
  v_legacy_count bigint := 0;
  v_legacy_amount numeric := 0;
  v_pending_count bigint := 0;
  v_approved_count bigint := 0;
  v_manual_cost_paid numeric := 0;
  v_manual_cost_reserved numeric := 0;
  v_mail_paid numeric := 0;
  v_mail_reserved numeric := 0;
  v_tech_paid numeric := 0;
  v_tech_reserved numeric := 0;
  v_tech_missing_fx_count bigint := 0;
  v_missing_fx_count bigint := 0;
  v_by_category jsonb := '{}'::jsonb;
  v_used numeric;
  v_remaining numeric;
  v_usage_pct numeric;
  v_cost_paid numeric;
  v_cost_reserved numeric;
  v_cost_used numeric;
  v_cost_remaining numeric;
  v_cost_usage_pct numeric;
begin
  if auth.uid() is not null and not public.can_use_payment_requests() then
    raise exception 'payment_request_forbidden' using errcode = '42501';
  end if;

  select coalesce(sum(request.amount) filter (
           where request.status = 'paid'
             and request.paid_on >= v_month
             and request.paid_on < v_next
             and request.budget_scope = 'general'
             and request.expense_type in ('one_time', 'legacy_unclassified')
         ), 0),
         coalesce(sum(request.amount) filter (
           where request.status = 'approved'
             and request.expected_payment_on >= v_month
             and request.expected_payment_on < v_next
             and request.budget_scope = 'general'
             and request.expense_type = 'one_time'
         ), 0),
         coalesce(sum(request.amount) filter (
           where request.status = 'paid'
             and request.paid_on >= v_month
             and request.paid_on < v_next
         ), 0),
         count(*) filter (
           where request.status = 'paid'
             and request.paid_on >= v_month
             and request.paid_on < v_next
             and request.budget_scope = 'general'
             and request.expense_type = 'legacy_unclassified'
         ),
         coalesce(sum(request.amount) filter (
           where request.status = 'paid'
             and request.paid_on >= v_month
             and request.paid_on < v_next
             and request.budget_scope = 'general'
             and request.expense_type = 'legacy_unclassified'
         ), 0),
         coalesce(sum(request.amount) filter (
           where request.status = 'paid'
             and request.paid_on >= v_month
             and request.paid_on < v_next
             and request.budget_scope = 'costs'
         ), 0),
         coalesce(sum(request.amount) filter (
           where request.status = 'approved'
             and request.expected_payment_on >= v_month
             and request.expected_payment_on < v_next
             and request.budget_scope = 'costs'
         ), 0)
    into v_paid_one_time,
         v_reserved_one_time,
         v_paid_all,
         v_legacy_count,
         v_legacy_amount,
         v_manual_cost_paid,
         v_manual_cost_reserved
    from public.payment_requests stored_request
    cross join lateral public.payment_request_effective(stored_request) request;

  select count(*) filter (
           where request.status = 'pending'
             and request.expected_payment_on >= v_month
             and request.expected_payment_on < v_next
         ),
         count(*) filter (
           where request.status = 'approved'
             and request.expected_payment_on >= v_month
             and request.expected_payment_on < v_next
         )
    into v_pending_count,
         v_approved_count
    from public.payment_requests stored_request
    cross join lateral public.payment_request_effective(stored_request) request;

  with calendar_costs as (
    select subscription.next_billing_date,
           subscription.cost_amount_rub as amount_rub,
           subscription.cost_amount_rub is null as missing_fx
      from public.email_subscriptions subscription
     where subscription.status = 'keep'
       and subscription.next_billing_date >= v_month
       and subscription.next_billing_date < v_next
  )
  select coalesce(sum(amount_rub) filter (
           where not missing_fx and next_billing_date <= v_today
         ), 0),
         coalesce(sum(amount_rub) filter (
           where not missing_fx and next_billing_date > v_today
         ), 0),
         count(*) filter (where missing_fx)
    into v_mail_paid,
         v_mail_reserved,
         v_missing_fx_count
    from calendar_costs;

  -- Current accepted cycles and immutable archived cycles share one stream.
  -- The anti-join is defensive: even inside a deferred-constraint transaction,
  -- the same (subscription, billing date) can never be counted twice.
  with tech_costs as (
    select subscription.next_billing_date as billing_date,
           subscription.cost_amount_rub as amount_rub,
           subscription.cost_amount_rub is null as missing_fx,
           subscription.next_billing_date <= v_today as paid,
           subscription.next_billing_date > v_today as reserved
      from public.tech_subscriptions subscription
     where subscription.status = 'keep'
       and subscription.next_billing_date >= v_month
       and subscription.next_billing_date < v_next
       and not exists (
         select 1
           from public.tech_subscription_cost_events event
          where event.subscription_id = subscription.id
            and event.billing_date = subscription.next_billing_date
       )
    union all
    select event.billing_date,
           event.amount_rub,
           false,
           true,
           false
      from public.tech_subscription_cost_events event
     where event.billing_date >= v_month
       and event.billing_date < v_next
  )
  select coalesce(sum(amount_rub) filter (
           where not missing_fx and paid
         ), 0),
         coalesce(sum(amount_rub) filter (
           where not missing_fx and reserved
         ), 0),
         count(*) filter (where missing_fx)
    into v_tech_paid,
         v_tech_reserved,
         v_tech_missing_fx_count
    from tech_costs;

  v_missing_fx_count := v_missing_fx_count + v_tech_missing_fx_count;

  with categories(category) as (
    values ('instantly'::text), ('email'), ('bases'), ('domains'), ('other')
  ), manual_totals as (
    select coalesce(request.cost_category, 'other') as category,
           coalesce(sum(request.amount) filter (
             where request.status = 'paid'
               and request.paid_on >= v_month
               and request.paid_on < v_next
           ), 0) as paid,
           coalesce(sum(request.amount) filter (
             where request.status = 'approved'
               and request.expected_payment_on >= v_month
               and request.expected_payment_on < v_next
           ), 0) as reserved
      from public.payment_requests stored_request
    cross join lateral public.payment_request_effective(stored_request) request
     where request.budget_scope = 'costs'
     group by coalesce(request.cost_category, 'other')
  ), all_totals as (
    select manual.category, manual.paid, manual.reserved
      from manual_totals manual
    union all
    select 'email', v_mail_paid, v_mail_reserved
    union all
    select 'other', v_tech_paid, v_tech_reserved
  ), category_totals as (
    select category.category,
           coalesce(sum(total.paid), 0) as paid,
           coalesce(sum(total.reserved), 0) as reserved
      from categories category
      left join all_totals total on total.category = category.category
     group by category.category
  )
  select jsonb_object_agg(
           category,
           jsonb_build_object('paid', paid, 'reserved', reserved)
         )
    into v_by_category
    from category_totals;

  v_used := v_paid_one_time + v_reserved_one_time;
  v_remaining := v_limit - v_used;
  v_usage_pct := case when v_limit = 0 then 0 else (v_used / v_limit) * 100 end;

  v_cost_paid := v_manual_cost_paid + v_mail_paid + v_tech_paid;
  v_cost_reserved := v_manual_cost_reserved + v_mail_reserved + v_tech_reserved;
  v_cost_used := v_cost_paid + v_cost_reserved;
  v_cost_remaining := v_cost_limit - v_cost_used;
  v_cost_usage_pct := case
    when v_cost_limit = 0 then 0
    else (v_cost_used / v_cost_limit) * 100
  end;

  return jsonb_build_object(
    'limit', v_limit,
    'paidOneTime', v_paid_one_time,
    'reservedOneTime', v_reserved_one_time,
    'usedOneTime', v_used,
    'remaining', v_remaining,
    'overage', greatest(v_used - v_limit, 0),
    'usagePct', v_usage_pct,
    'level', case
      when v_usage_pct > 100 then 'exceeded'
      when v_usage_pct >= 80 then 'warning'
      else 'normal'
    end,
    'legacyCount', v_legacy_count,
    'legacyAmount', v_legacy_amount,
    'paidAll', v_paid_all + v_mail_paid + v_tech_paid,
    'pendingCount', v_pending_count,
    'approvedCount', v_approved_count,
    'costBudget', jsonb_build_object(
      'limit', v_cost_limit,
      'paid', v_cost_paid,
      'reserved', v_cost_reserved,
      'used', v_cost_used,
      'remaining', v_cost_remaining,
      'overage', greatest(v_cost_used - v_cost_limit, 0),
      'usagePct', v_cost_usage_pct,
      'level', case
        when v_cost_usage_pct > 100 then 'exceeded'
        when v_cost_usage_pct >= 80 then 'warning'
        else 'normal'
      end,
      'dataComplete', v_missing_fx_count = 0,
      'missingFxCount', v_missing_fx_count,
      'mailPaid', v_mail_paid,
      'mailReserved', v_mail_reserved,
      'techPaid', v_tech_paid,
      'techReserved', v_tech_reserved,
      'manualPaid', v_manual_cost_paid,
      'manualReserved', v_manual_cost_reserved,
      'byCategory', coalesce(v_by_category, '{}'::jsonb)
    )
  );
end;
$$;

create or replace function public.payment_request_api_record(p_request_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'id', request.id,
           'user_id', request.requester_user_id,
           'requester_name', request.requester_name,
           'department', request.department,
           'description', request.description,
           'amount', request.amount,
           'project_id', request.project_id,
           'project_name', project.name,
           'project_client', project.client,
           'comment', request.comment,
           'expense_type', request.expense_type,
           'budget_scope', request.budget_scope,
           'cost_category', request.cost_category,
           'status', request.status,
           'approval_reason', request.approval_reason,
           'expected_payment_on', request.expected_payment_on,
           'paid_on', request.paid_on,
           'paid_on_source', request.paid_on_source,
           'auto_payment_on', request.auto_payment_on,
           'urgency', request.urgency,
           'decider_name', decider.full_name,
           'decided_by', request.decided_by,
           'decided_at', request.decided_at,
           'decision_comment', request.decision_comment,
           'paid_by', request.paid_by,
           'paid_by_name', payer.full_name,
           'paid_at', request.paid_at,
           'created_at', request.created_at,
           'updated_at', request.updated_at,
           'document_url', case
             when auth.uid() = request.user_id
               or public.can_manage_payment_requests()
             then request.document_url
             else null
           end
         )
    from public.payment_requests stored_request
    cross join lateral public.payment_request_effective(stored_request) request
    left join public.projects project on project.id = request.project_id
    left join public.profiles decider on decider.id = request.decided_by
    left join public.profiles payer on payer.id = request.paid_by
   where request.id = p_request_id;
$$;

drop function if exists public.list_payment_requests_with_budget(date);
create or replace function public.list_payment_requests_with_budget(p_month date)
returns table (
  id uuid,
  user_id uuid,
  requester_name text,
  department text,
  description text,
  amount numeric,
  project_id uuid,
  project_name text,
  project_client text,
  comment text,
  expense_type text,
  budget_scope text,
  cost_category text,
  status text,
  approval_reason text,
  expected_payment_on date,
  paid_on date,
  paid_on_source text,
  urgency text,
  document_url text,
  decided_by uuid,
  decider_name text,
  decided_at timestamptz,
  decision_comment text,
  paid_by uuid,
  paid_by_name text,
  paid_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  auto_payment_on date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_next date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  if not public.can_use_payment_requests() then
    raise exception 'payment_request_forbidden' using errcode = '42501';
  end if;

  return query
  select request.id,
         request.requester_user_id,
         request.requester_name,
         request.department,
         request.description,
         request.amount,
         request.project_id,
         project.name,
         project.client,
         request.comment,
         request.expense_type,
         request.budget_scope,
         request.cost_category,
         request.status,
         request.approval_reason,
         request.expected_payment_on,
         request.paid_on,
         request.paid_on_source,
         request.urgency,
         case
           when auth.uid() = request.user_id or public.can_manage_payment_requests()
           then request.document_url
           else null
         end,
         request.decided_by,
         decider.full_name,
         request.decided_at,
         request.decision_comment,
         request.paid_by,
         payer.full_name,
         request.paid_at,
         request.created_at,
         request.updated_at,
         request.auto_payment_on
    from public.payment_requests stored_request
    cross join lateral public.payment_request_effective(stored_request) request
    left join public.projects project on project.id = request.project_id
    left join public.profiles decider on decider.id = request.decided_by
    left join public.profiles payer on payer.id = request.paid_by
   where (
     request.expected_payment_on >= v_month
     and request.expected_payment_on < v_next
   ) or (
     request.paid_on >= v_month
     and request.paid_on < v_next
   )
   order by coalesce(request.paid_on, request.expected_payment_on) desc,
            request.created_at desc,
            request.id;
end;
$$;

create or replace function public.list_payment_requests(p_month date)
returns table (
  id uuid,
  user_id uuid,
  requester_name text,
  department text,
  description text,
  amount numeric,
  project_id uuid,
  project_name text,
  project_client text,
  comment text,
  expense_type text,
  status text,
  approval_reason text,
  expected_payment_on date,
  paid_on date,
  paid_on_source text,
  urgency text,
  document_url text,
  decided_by uuid,
  decider_name text,
  decided_at timestamptz,
  decision_comment text,
  paid_by uuid,
  paid_by_name text,
  paid_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_next date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  if not public.can_use_payment_requests() then
    raise exception 'payment_request_forbidden' using errcode = '42501';
  end if;

  return query
  select request.id,
         request.requester_user_id,
         request.requester_name,
         request.department,
         request.description,
         request.amount,
         request.project_id,
         project.name,
         project.client,
         request.comment,
         request.expense_type,
         request.status,
         request.approval_reason,
         request.expected_payment_on,
         request.paid_on,
         request.paid_on_source,
         request.urgency,
         case when auth.uid() = request.user_id or public.can_manage_payment_requests() then request.document_url else null end,
         request.decided_by,
         decider.full_name,
         request.decided_at,
         request.decision_comment,
         request.paid_by,
         payer.full_name,
         request.paid_at,
         request.created_at,
         request.updated_at
  from public.payment_requests stored_request
    cross join lateral public.payment_request_effective(stored_request) request
  left join public.projects project on project.id = request.project_id
  left join public.profiles decider on decider.id = request.decided_by
  left join public.profiles payer on payer.id = request.paid_by
  where (
    request.expected_payment_on >= v_month
    and request.expected_payment_on < v_next
  ) or (
    request.paid_on >= v_month
    and request.paid_on < v_next
  )
  order by coalesce(request.paid_on, request.expected_payment_on) desc,
           request.created_at desc,
           request.id;
end;
$$;

create or replace function public.submit_payment_request_internal(
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
  p_document_url text,
  p_legacy_signature boolean
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
    sha256(convert_to((jsonb_build_object(
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
    ) - case when p_legacy_signature then array['budget_scope', 'cost_category'] else array[]::text[] end)::text, 'utf8')),
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
    v_existing := public.payment_request_effective(v_existing);
    perform public.lock_payment_request_months(array[v_month]);
    return jsonb_build_object(
      'request', public.payment_request_api_record(v_existing.id),
      'summary', public.payment_request_month_summary(v_month),
      'outcome', case
        when v_existing.status = 'paid' then 'recorded_paid'
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
      v_status := public.payment_request_approved_status(p_expected_payment_on);
      v_approval_reason := null;
      v_outcome := case when v_status = 'paid' then 'recorded_paid' else 'auto_approved' end;
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
    auto_payment_on,
    auto_payment_by,
    auto_payment_authorized_at,
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
    case when v_status = 'approved' then p_expected_payment_on else null end,
    case when v_status = 'approved' then v_actor_id else null end,
    case when v_status = 'approved' then now() else null end,
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
      'approval_reason', v_approval_reason,
      'auto_payment_on', case when v_status = 'approved' then p_expected_payment_on else null end
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

revoke all on function public.submit_payment_request_internal(uuid, text, text, numeric, uuid, text, text, text, text, date, text, text, boolean) from public, anon, authenticated;

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
returns jsonb language sql security definer set search_path = ''
as $$
  select public.submit_payment_request_internal(
    p_idempotency_key, p_department, p_description, p_amount, p_project_id,
    p_comment, p_expense_type, p_budget_scope, p_cost_category,
    p_expected_payment_on, p_urgency, p_document_url, false
  );
$$;

create or replace function public.submit_payment_request(
  p_idempotency_key uuid,
  p_department text,
  p_description text,
  p_amount numeric,
  p_project_id uuid,
  p_comment text,
  p_expense_type text,
  p_expected_payment_on date,
  p_urgency text,
  p_document_url text
)
returns jsonb language sql security definer set search_path = ''
as $$
  select public.submit_payment_request_internal(
    p_idempotency_key, p_department, p_description, p_amount, p_project_id,
    p_comment, p_expense_type, 'general', null,
    p_expected_payment_on, p_urgency, p_document_url, true
  );
$$;

create or replace function public.transition_payment_request(
  p_request_id uuid,
  p_action text,
  p_expected_updated_at timestamptz,
  p_decision_comment text default null,
  p_paid_on date default null,
  p_expense_type text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_request public.payment_requests%rowtype;
  v_updated public.payment_requests%rowtype;
  v_lock_months date[];
  v_affected_months text[];
  v_month_key text;
  v_summaries jsonb := '[]'::jsonb;
  v_outcome text;
begin
  if v_actor_id is null or not public.can_manage_payment_requests() then
    raise exception 'payment_request_forbidden' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('approve', 'reject', 'mark_paid', 'classify_legacy') then
    raise exception 'payment_request_invalid_transition' using errcode = '23514';
  end if;
  if p_expected_updated_at is null then
    raise exception 'payment_request_conflict' using errcode = '40001';
  end if;

  -- Freeze the manager who decided, so the trail survives their offboarding.
  select coalesce(nullif(btrim(actor.full_name), ''), 'Неизвестно')
  into v_actor_name
  from public.profiles actor
  where actor.id = v_actor_id;
  v_actor_name := coalesce(v_actor_name, 'Неизвестно');

  select request.*
  into v_request
  from public.payment_requests request
  where request.id = p_request_id
  for update;

  if not found then
    raise exception 'payment_request_not_found' using errcode = 'P0002';
  end if;
  if v_request.updated_at is distinct from p_expected_updated_at then
    raise exception 'payment_request_conflict' using errcode = '40001';
  end if;

  -- Date rollover must also invalidate stale actions on an effectively paid row.
  v_request := public.payment_request_effective(v_request);

  if p_action = 'mark_paid' and v_request.status <> 'approved' then
    raise exception 'payment_request_invalid_transition' using errcode = '23514';
  end if;
  if p_action = 'classify_legacy' and p_paid_on is null then raise exception 'payment_request_invalid_transition' using errcode = '23514'; end if;
  if p_action = 'classify_legacy'
     and (
       v_request.expense_type <> 'legacy_unclassified'
       or v_request.status <> 'paid'
     )
  then
    raise exception 'payment_request_invalid_transition' using errcode = '23514';
  end if;
  if p_action = 'approve' and v_request.status <> 'pending' then
    raise exception 'payment_request_invalid_transition' using errcode = '23514';
  end if;
  if p_action = 'reject' and v_request.status not in ('pending', 'approved') then
    raise exception 'payment_request_invalid_transition' using errcode = '23514';
  end if;
  if p_action = 'reject'
     and char_length(btrim(coalesce(p_decision_comment, ''))) not between 1 and 1000
  then
    raise exception 'payment_request_invalid_transition' using errcode = '23514';
  end if;
  if p_action = 'approve'
     and p_decision_comment is not null
     and char_length(p_decision_comment) > 1000
  then
    raise exception 'payment_request_invalid_transition' using errcode = '23514';
  end if;
  if p_action in ('approve', 'reject')
     and (p_paid_on is not null or p_expense_type is not null)
  then
    raise exception 'payment_request_invalid_transition' using errcode = '23514';
  end if;
  if p_action = 'mark_paid'
     and (p_decision_comment is not null or p_expense_type is not null)
  then
    raise exception 'payment_request_invalid_transition' using errcode = '23514';
  end if;
  if p_action = 'classify_legacy' and p_decision_comment is not null then
    raise exception 'payment_request_invalid_transition' using errcode = '23514';
  end if;
  if p_action in ('mark_paid', 'classify_legacy')
     and (
       p_paid_on is null
       or p_paid_on > (now() at time zone 'Europe/Moscow')::date
     )
  then
    raise exception 'payment_request_invalid_transition' using errcode = '23514';
  end if;
  if p_action = 'classify_legacy'
     and (p_expense_type is null or p_expense_type not in ('one_time', 'planned'))
  then
    raise exception 'payment_request_invalid_transition' using errcode = '23514';
  end if;

  if p_action in ('approve', 'reject') then
    v_lock_months := array[date_trunc('month', v_request.expected_payment_on)::date];
  elsif p_action = 'mark_paid' then
    v_lock_months := array[
      date_trunc('month', v_request.expected_payment_on)::date,
      date_trunc('month', p_paid_on)::date
    ];
  else
    v_lock_months := array[
      date_trunc('month', v_request.paid_on)::date,
      date_trunc('month', p_paid_on)::date
    ];
  end if;
  perform public.lock_payment_request_months(v_lock_months);

  if p_action = 'approve' then
    update public.payment_requests
    set status = case when budget_scope = 'general'
                      then public.payment_request_approved_status(expected_payment_on)
                      else 'approved' end,
        paid_on = case when budget_scope = 'general' and expected_payment_on <= public.payment_request_today() then expected_payment_on else null end,
        paid_on_source = case when budget_scope = 'general' and expected_payment_on <= public.payment_request_today() then 'entered' else null end,
        paid_by = case when budget_scope = 'general' and expected_payment_on <= public.payment_request_today() then v_actor_id else null end,
        paid_at = case when budget_scope = 'general' and expected_payment_on <= public.payment_request_today() then now() else null end,
        auto_payment_on = case when budget_scope = 'general' and expected_payment_on > public.payment_request_today() then expected_payment_on else null end,
        auto_payment_by = case when budget_scope = 'general' and expected_payment_on > public.payment_request_today() then v_actor_id else null end,
        auto_payment_authorized_at = case when budget_scope = 'general' and expected_payment_on > public.payment_request_today() then now() else null end,
        decided_by = v_actor_id,
        decided_at = now(),
        decision_comment = nullif(btrim(p_decision_comment), ''),
        updated_at = now()
    where id = v_request.id
    returning * into v_updated;
    v_outcome := v_updated.status;
  elsif p_action = 'reject' then
    update public.payment_requests
    set status = 'rejected',
        decided_by = v_actor_id,
        decided_at = now(),
        decision_comment = btrim(p_decision_comment),
        updated_at = now()
    where id = v_request.id
    returning * into v_updated;
    v_outcome := 'rejected';
  elsif p_action = 'mark_paid' then
    update public.payment_requests
    set status = 'paid',
        paid_on = p_paid_on,
        paid_on_source = 'entered',
        paid_by = auth.uid(),
        paid_at = now(),
        updated_at = now()
    where id = v_request.id
    returning * into v_updated;
    v_outcome := 'paid';
  else
    update public.payment_requests
    set expense_type = p_expense_type,
        expected_payment_on = p_paid_on,
        paid_on = p_paid_on,
        paid_on_source = 'entered',
        paid_by = auth.uid(),
        paid_at = now(),
        updated_at = now()
    where id = v_request.id
    returning * into v_updated;
    v_outcome := 'legacy_classified';
  end if;

  select array_agg(to_char(month_start, 'YYYY-MM') order by month_start)
  into v_affected_months
  from (
    select distinct date_trunc('month', month_value)::date as month_start
    from unnest(v_lock_months) as affected(month_value)
    where month_value is not null
  ) months;

  insert into public.payment_request_events (
    payment_request_id,
    actor_user_id,
    actor_name,
    event_type,
    from_status,
    to_status,
    metadata
  ) values (
    v_updated.id,
    v_actor_id,
    v_actor_name,
    p_action,
    v_request.status,
    v_updated.status,
    jsonb_build_object(
      'action', p_action,
      'amount', v_updated.amount,
      'from_status', v_request.status,
      'to_status', v_updated.status,
      'old_expense_type', v_request.expense_type,
      'new_expense_type', v_updated.expense_type,
      'old_expected_payment_on', v_request.expected_payment_on,
      'new_expected_payment_on', v_updated.expected_payment_on,
      'old_paid_on', v_request.paid_on,
      'new_paid_on', v_updated.paid_on,
      'auto_payment_on', v_updated.auto_payment_on,
      'approval_reason', v_updated.approval_reason
    )
  );

  foreach v_month_key in array v_affected_months loop
    v_summaries := v_summaries || jsonb_build_array(
      jsonb_build_object(
        'month', v_month_key,
        'summary', public.payment_request_month_summary((v_month_key || '-01')::date)
      )
    );
  end loop;

  return jsonb_build_object(
    'request', public.payment_request_api_record(v_updated.id),
    'affectedMonths', coalesce(to_jsonb(v_affected_months), '[]'::jsonb),
    'summaries', v_summaries,
    'outcome', v_outcome
  );
end;
$$;

create or replace function public.payment_requests_read_model(p_month date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.can_use_payment_requests() then
    raise exception 'payment_request_forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'asOf', public.payment_request_today(),
    'requests', (select coalesce(jsonb_agg(to_jsonb(request)), '[]'::jsonb)
                   from public.list_payment_requests_with_budget(p_month) request),
    'summary', public.payment_request_month_summary(p_month)
  );
end;
$$;

revoke all on function public.list_payment_requests_with_budget(date) from public, anon, authenticated;
grant execute on function public.list_payment_requests_with_budget(date) to authenticated;
revoke all on function public.payment_requests_read_model(date) from public, anon, authenticated;
grant execute on function public.payment_requests_read_model(date) to authenticated;
