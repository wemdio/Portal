-- Separate company cost budget: Instantly, email accounts, databases and domains.
-- The existing 75k/40k one-time budget remains independent. Email calendar
-- rows marked `keep` are the source of truth for the `email` category: before
-- the billing date they reserve the budget, on and after that date they are fact.

alter table public.payment_requests
  add column if not exists budget_scope text,
  add column if not exists cost_category text;

update public.payment_requests
   set budget_scope = 'general'
 where budget_scope is null;

alter table public.payment_requests
  alter column budget_scope set default 'general',
  alter column budget_scope set not null,
  drop constraint if exists payment_requests_budget_scope_check,
  drop constraint if exists payment_requests_cost_category_check;

alter table public.payment_requests
  add constraint payment_requests_budget_scope_check
    check (budget_scope in ('general', 'costs')),
  add constraint payment_requests_cost_category_check
    check (
      (budget_scope = 'general' and cost_category is null)
      or (
        budget_scope = 'costs'
        and cost_category in ('instantly', 'email', 'bases', 'domains', 'other')
      )
    );

alter table public.email_subscriptions
  add column if not exists cost_amount_rub numeric(12, 2),
  drop constraint if exists email_subscriptions_billing_amount_nonnegative;

alter table public.email_subscriptions
  add constraint email_subscriptions_billing_amount_nonnegative
    check (
      billing_amount >= 0
      and billing_amount <> 'NaN'::numeric
    );

create or replace function public.can_access_email_subscriptions()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
       from public.profiles actor
      where actor.id = auth.uid()
       and coalesce(actor.is_demo, false) = false
       and actor.role in ('technician', 'lead', 'director', 'admin')
  );
$$;

create or replace function public.can_manage_email_subscriptions()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles actor
     where actor.id = auth.uid()
       and coalesce(actor.is_demo, false) = false
       and actor.role in ('technician', 'admin')
  );
$$;

create or replace function public.can_decide_email_subscriptions()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles actor
     where actor.id = auth.uid()
       and coalesce(actor.is_demo, false) = false
       and actor.role in ('lead', 'director', 'admin')
  );
$$;

drop policy if exists email_subscriptions_select on public.email_subscriptions;
drop policy if exists email_subscriptions_insert on public.email_subscriptions;
drop policy if exists email_subscriptions_update on public.email_subscriptions;
drop policy if exists email_subscriptions_delete on public.email_subscriptions;

create policy email_subscriptions_select on public.email_subscriptions
  for select to authenticated
  using (public.can_access_email_subscriptions());

create policy email_subscriptions_insert on public.email_subscriptions
  for insert to authenticated
  with check (public.can_manage_email_subscriptions());

create policy email_subscriptions_update on public.email_subscriptions
  for update to authenticated
  using (public.can_manage_email_subscriptions())
  with check (public.can_manage_email_subscriptions());

create policy email_subscriptions_delete on public.email_subscriptions
  for delete to authenticated
  using (
    exists (
      select 1
        from public.profiles actor
       where actor.id = auth.uid()
         and coalesce(actor.is_demo, false) = false
         and actor.role = 'admin'
    )
  );

create index if not exists idx_payment_requests_cost_budget_expected
  on public.payment_requests (expected_payment_on, cost_category, status)
  where budget_scope = 'costs';

create index if not exists idx_payment_requests_cost_budget_paid
  on public.payment_requests (paid_on, cost_category)
  where budget_scope = 'costs' and status = 'paid';

create or replace function public.payment_request_cost_month_limit(p_month date)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select 650000::numeric;
$$;

create or replace function public.email_subscription_amount_rub(
  p_amount numeric,
  p_currency text,
  p_billing_date date
)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rate numeric;
begin
  if p_amount is null or p_currency is null or p_billing_date is null then
    return null;
  end if;
  if p_amount = 0 then
    return 0;
  end if;
  if upper(p_currency) = 'RUB' then
    return round(p_amount, 2);
  end if;

  select rate.rate
    into v_rate
    from public.fx_rates rate
   where rate.currency = upper(p_currency)
     and rate.rate_date <= p_billing_date
   order by rate.rate_date desc
   limit 1;

  if v_rate is null then
    return null;
  end if;
  return round(p_amount * v_rate, 2);
end;
$$;

-- Freeze the RUB value when a row becomes `keep`. Later FX imports must not
-- silently move an already accepted month above the hard company cap.
update public.email_subscriptions subscription
   set cost_amount_rub = public.email_subscription_amount_rub(
     subscription.billing_amount,
     subscription.currency,
     subscription.next_billing_date
   )
 where subscription.status = 'keep'
   and subscription.cost_amount_rub is null;

create or replace function public.freeze_email_subscription_cost()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount_rub numeric;
begin
  if new.status <> 'keep' then
    new.cost_amount_rub := null;
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.status = 'keep'
     and old.cost_amount_rub is not null
     and new.billing_amount is not distinct from old.billing_amount
     and upper(new.currency) is not distinct from upper(old.currency)
     and new.next_billing_date is not distinct from old.next_billing_date
  then
    -- Ignore any direct attempt to forge the frozen RUB amount.
    new.cost_amount_rub := old.cost_amount_rub;
    return new;
  end if;

  v_amount_rub := public.email_subscription_amount_rub(
    new.billing_amount,
    new.currency,
    new.next_billing_date
  );
  if v_amount_rub is null then
    raise exception 'payment_request_cost_budget_incomplete' using errcode = 'P0001';
  end if;
  new.cost_amount_rub := v_amount_rub;
  return new;
end;
$$;

drop trigger if exists email_subscriptions_freeze_cost on public.email_subscriptions;
create trigger email_subscriptions_freeze_cost
  before insert or update on public.email_subscriptions
  for each row
  execute function public.freeze_email_subscription_cost();

create or replace function public.protect_email_subscription_decision_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_is_demo boolean;
  v_rpc_context text := coalesce(
    current_setting('portal.email_subscription_rpc', true),
    ''
  );
begin
  if auth.uid() is null then
    return new;
  end if;

  select actor.role, coalesce(actor.is_demo, false)
    into v_role, v_is_demo
    from public.profiles actor
   where actor.id = auth.uid();
  if not found
     or v_is_demo
     or v_role not in ('technician', 'lead', 'director', 'admin')
  then
    raise exception 'email_subscription_forbidden' using errcode = '42501';
  end if;

  if v_role = 'admin' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if v_rpc_context in ('pay_today', 'decision') then
      return new;
    end if;
    if v_role <> 'technician'
       or new.status <> 'active'
       or new.lead_decision is not null
       or new.lead_decision_by is not null
       or new.lead_decision_at is not null
       or new.lead_notes is not null
    then
      raise exception 'email_subscription_decision_forbidden' using errcode = '42501';
    end if;
    return new;
  end if;

  if v_rpc_context = 'decision' and v_role in ('lead', 'director') then
    return new;
  end if;

  if v_role = 'technician' then
    if old.status not in ('active', 'pending_review')
       or old.lead_decision is not null
       or new.lead_decision is distinct from old.lead_decision
       or new.lead_decision_by is distinct from old.lead_decision_by
       or new.lead_decision_at is distinct from old.lead_decision_at
       or new.lead_notes is distinct from old.lead_notes
       or (
         new.status is distinct from old.status
         and not (old.status = 'active' and new.status = 'pending_review')
       )
    then
      raise exception 'email_subscription_decision_forbidden' using errcode = '42501';
    end if;
    return new;
  end if;

  raise exception 'email_subscription_decision_forbidden' using errcode = '42501';
end;
$$;

drop trigger if exists email_subscriptions_protect_decision_fields
  on public.email_subscriptions;
create trigger email_subscriptions_protect_decision_fields
  before insert or update on public.email_subscriptions
  for each row
  execute function public.protect_email_subscription_decision_fields();

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
  v_today date := (now() at time zone 'Europe/Moscow')::date;
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
  -- Trigger-based budget guards also call this function for trusted
  -- service/postgres writes where auth.uid() is intentionally absent.
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
    from public.payment_requests request;

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
    from public.payment_requests request;

  with calendar_costs as (
      select subscription.id,
             subscription.next_billing_date,
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
      from public.payment_requests request
     where request.budget_scope = 'costs'
     group by coalesce(request.cost_category, 'other')
  ), all_totals as (
    select manual.category, manual.paid, manual.reserved
      from manual_totals manual
    union all
    select 'email', v_mail_paid, v_mail_reserved
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

  v_cost_paid := v_manual_cost_paid + v_mail_paid;
  v_cost_reserved := v_manual_cost_reserved + v_mail_reserved;
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
    'paidAll', v_paid_all + v_mail_paid,
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
      'manualPaid', v_manual_cost_paid,
      'manualReserved', v_manual_cost_reserved,
      'byCategory', coalesce(v_by_category, '{}'::jsonb)
    )
  );
end;
$$;

create or replace function public.assert_payment_cost_budget_month(p_month date)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_summary jsonb := public.payment_request_month_summary(p_month);
begin
  if coalesce((v_summary #>> '{costBudget,dataComplete}')::boolean, false) = false then
    raise exception 'payment_request_cost_budget_incomplete' using errcode = 'P0001';
  end if;
  if coalesce((v_summary #>> '{costBudget,used}')::numeric, 0)
     > coalesce((v_summary #>> '{costBudget,limit}')::numeric, 0)
  then
    raise exception 'payment_request_cost_limit_exceeded' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.enforce_payment_request_cost_budget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_row public.payment_requests%rowtype;
  new_row public.payment_requests%rowtype;
  v_old_month date;
  v_new_month date;
  v_old_amount numeric := 0;
  v_new_amount numeric := 0;
  v_lock_months date[];
  v_month date;
begin
  if tg_op <> 'INSERT' then
    old_row := old;
    if old_row.budget_scope = 'costs' then
      if old_row.status = 'paid' and old_row.paid_on is not null then
        v_old_month := date_trunc('month', old_row.paid_on)::date;
        v_old_amount := old_row.amount;
      elsif old_row.status = 'approved' and old_row.expected_payment_on is not null then
        v_old_month := date_trunc('month', old_row.expected_payment_on)::date;
        v_old_amount := old_row.amount;
      end if;
    end if;
  end if;

  if tg_op <> 'DELETE' then
    new_row := new;
    if new_row.budget_scope = 'costs' then
      if new_row.status = 'paid' and new_row.paid_on is not null then
        v_new_month := date_trunc('month', new_row.paid_on)::date;
        v_new_amount := new_row.amount;
      elsif new_row.status = 'approved' and new_row.expected_payment_on is not null then
        v_new_month := date_trunc('month', new_row.expected_payment_on)::date;
        v_new_amount := new_row.amount;
      end if;
    end if;
  end if;

  v_lock_months := array[v_old_month, v_new_month];
  perform public.lock_payment_request_months(v_lock_months);

  for v_month in
    select movement.month_start
      from (
        values
          (v_old_month, -coalesce(v_old_amount, 0)),
          (v_new_month, coalesce(v_new_amount, 0))
      ) as movement(month_start, amount_delta)
     where movement.month_start is not null
     group by movement.month_start
    having sum(movement.amount_delta) > 0
     order by movement.month_start
  loop
    perform public.assert_payment_cost_budget_month(v_month);
  end loop;

  return null;
end;
$$;

drop trigger if exists payment_requests_cost_budget_guard on public.payment_requests;
create constraint trigger payment_requests_cost_budget_guard
  after insert or update or delete on public.payment_requests
  deferrable initially immediate
  for each row
  execute function public.enforce_payment_request_cost_budget();

create or replace function public.enforce_email_subscription_cost_budget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_month date;
  v_new_month date;
  v_old_amount numeric := 0;
  v_new_amount numeric := 0;
  v_lock_months date[];
  v_month date;
begin
  if tg_op <> 'INSERT' and old.status = 'keep' then
    v_old_month := date_trunc('month', old.next_billing_date)::date;
    v_old_amount := old.cost_amount_rub;
  end if;

  if tg_op <> 'DELETE' and new.status = 'keep' then
    v_new_month := date_trunc('month', new.next_billing_date)::date;
    v_new_amount := new.cost_amount_rub;
  end if;

  v_lock_months := array[v_old_month, v_new_month];
  perform public.lock_payment_request_months(v_lock_months);

  -- A newly introduced/changed `keep` row without an FX rate must never be
  -- treated as zero. The summary raises the domain-specific incomplete error.
  if v_new_month is not null and v_new_amount is null then
    perform public.assert_payment_cost_budget_month(v_new_month);
  end if;

  for v_month in
    select movement.month_start
      from (
        values
          (v_old_month, -coalesce(v_old_amount, 0)),
          (v_new_month, coalesce(v_new_amount, 0))
      ) as movement(month_start, amount_delta)
     where movement.month_start is not null
     group by movement.month_start
    having sum(movement.amount_delta) > 0
     order by movement.month_start
  loop
    perform public.assert_payment_cost_budget_month(v_month);
  end loop;

  return null;
end;
$$;

drop trigger if exists email_subscriptions_cost_budget_guard on public.email_subscriptions;
create constraint trigger email_subscriptions_cost_budget_guard
  after insert or update or delete on public.email_subscriptions
  deferrable initially immediate
  for each row
  execute function public.enforce_email_subscription_cost_budget();

create or replace function public.email_subscription_next_billing_date(
  p_date date,
  p_billing_cycle text
)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_months integer := case p_billing_cycle
    when 'monthly' then 1
    when 'quarterly' then 3
    when 'yearly' then 12
    else null
  end;
  v_target_month date;
  v_target_day integer;
begin
  if p_date is null or v_months is null then
    raise exception 'email_subscription_invalid_billing_cycle' using errcode = '22023';
  end if;

  v_target_month := (
    date_trunc('month', p_date) + pg_catalog.make_interval(months => v_months)
  )::date;
  v_target_day := least(
    extract(day from p_date)::integer,
    extract(day from (
      v_target_month + interval '1 month - 1 day'
    ))::integer
  );

  return v_target_month + (v_target_day - 1);
end;
$$;

create or replace function public.lock_email_subscription_project_dates(
  p_project_name text,
  p_dates date[]
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_date date;
begin
  if char_length(btrim(coalesce(p_project_name, ''))) = 0 then
    raise exception 'email_subscription_invalid_input' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'email_subscriptions:project:' || lower(btrim(p_project_name)),
      60901000
    )
  );

  for v_date in
    select distinct candidate.billing_date
      from unnest(p_dates) as candidate(billing_date)
     where candidate.billing_date is not null
     order by candidate.billing_date
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'email_subscriptions:' || lower(btrim(p_project_name)) || ':' || v_date::text,
        60901001
      )
    );
  end loop;
end;
$$;

create or replace function public.record_email_subscription_payment_today(
  p_project_id uuid,
  p_project_name text,
  p_email_provider text,
  p_email_count integer,
  p_billing_amount numeric,
  p_currency text,
  p_billing_cycle text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_today date := (now() at time zone 'Europe/Moscow')::date;
  v_next_date date;
  v_payment_id uuid;
  v_next_id uuid;
begin
  if v_actor_id is null or not public.can_manage_email_subscriptions() then
    raise exception 'email_subscription_forbidden' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_project_name, ''))) not between 1 and 500
     or char_length(coalesce(p_email_provider, '')) > 500
     or p_email_count is null
     or p_email_count < 1
     or p_email_count > 1000000
     or p_billing_amount is null
     or p_billing_amount < 0
     or p_billing_amount > 99999999.99
     or p_billing_amount <> round(p_billing_amount, 2)
     or upper(coalesce(p_currency, '')) not in ('RUB', 'USD', 'EUR')
     or coalesce(p_billing_cycle, '') not in ('monthly', 'quarterly', 'yearly')
     or char_length(coalesce(p_notes, '')) > 5000
  then
    raise exception 'email_subscription_invalid_input' using errcode = '22023';
  end if;
  if p_project_id is not null and not exists (
    select 1 from public.projects project where project.id = p_project_id
  ) then
    raise exception 'email_subscription_project_not_found' using errcode = 'P0002';
  end if;

  perform pg_catalog.set_config(
    'portal.email_subscription_rpc',
    'pay_today',
    true
  );

  v_next_date := public.email_subscription_next_billing_date(
    v_today,
    p_billing_cycle
  );
  perform public.lock_email_subscription_project_dates(
    p_project_name,
    array[v_today, v_next_date]
  );

  if exists (
    select 1
      from public.email_subscriptions subscription
     where lower(btrim(subscription.project_name)) = lower(btrim(p_project_name))
       and subscription.next_billing_date = v_today
  ) then
    raise exception 'email_subscription_duplicate_today' using errcode = 'P0001';
  end if;

  insert into public.email_subscriptions (
    project_id,
    project_name,
    email_provider,
    email_count,
    next_billing_date,
    billing_amount,
    currency,
    billing_cycle,
    status,
    lead_decision,
    lead_decision_by,
    lead_decision_at,
    created_by,
    notes
  ) values (
    p_project_id,
    btrim(p_project_name),
    coalesce(p_email_provider, ''),
    p_email_count,
    v_today,
    round(p_billing_amount, 2),
    upper(p_currency),
    p_billing_cycle,
    'keep',
    'keep',
    v_actor_id,
    now(),
    v_actor_id,
    nullif(btrim(p_notes), '')
  ) returning id into v_payment_id;

  insert into public.email_subscriptions (
    project_id,
    project_name,
    email_provider,
    email_count,
    next_billing_date,
    billing_amount,
    currency,
    billing_cycle,
    status,
    created_by,
    notes
  )
  select p_project_id,
         btrim(p_project_name),
         coalesce(p_email_provider, ''),
         p_email_count,
         v_next_date,
         round(p_billing_amount, 2),
         upper(p_currency),
         p_billing_cycle,
         'active',
         v_actor_id,
         nullif(btrim(p_notes), '')
   where not exists (
     select 1
       from public.email_subscriptions subscription
      where lower(btrim(subscription.project_name)) = lower(btrim(p_project_name))
        and subscription.next_billing_date = v_next_date
   )
  returning id into v_next_id;

  return jsonb_build_object(
    'paymentId', v_payment_id,
    'nextSubscriptionId', v_next_id,
    'paymentDate', v_today,
    'nextBillingDate', v_next_date
  );
end;
$$;

drop function if exists public.decide_email_subscription(uuid, text, text);

create or replace function public.decide_email_subscription(
  p_subscription_id uuid,
  p_decision text,
  p_notes text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_snapshot public.email_subscriptions%rowtype;
  v_subscription public.email_subscriptions%rowtype;
  v_previous_decision text;
  v_next_date date;
  v_next_id uuid;
  v_removed_next integer := 0;
begin
  if v_actor_id is null or not public.can_decide_email_subscriptions() then
    raise exception 'email_subscription_forbidden' using errcode = '42501';
  end if;
  if p_subscription_id is null
     or coalesce(p_decision, '') not in ('keep', 'cancel')
     or char_length(coalesce(p_notes, '')) > 5000
     or p_expected_updated_at is null
  then
    raise exception 'email_subscription_invalid_input' using errcode = '22023';
  end if;

  select subscription.*
    into v_snapshot
    from public.email_subscriptions subscription
   where subscription.id = p_subscription_id;
  if not found then
    raise exception 'email_subscription_not_found' using errcode = 'P0002';
  end if;
  if v_snapshot.status = 'expired' then
    raise exception 'email_subscription_expired' using errcode = '22023';
  end if;

  v_next_date := public.email_subscription_next_billing_date(
    v_snapshot.next_billing_date,
    v_snapshot.billing_cycle
  );
  perform public.lock_email_subscription_project_dates(
    v_snapshot.project_name,
    array[v_snapshot.next_billing_date, v_next_date]
  );

  select subscription.*
    into v_subscription
    from public.email_subscriptions subscription
   where subscription.id = p_subscription_id
   for update;
  if not found then
    raise exception 'email_subscription_not_found' using errcode = 'P0002';
  end if;
  if v_subscription.project_name is distinct from v_snapshot.project_name
     or v_subscription.next_billing_date is distinct from v_snapshot.next_billing_date
     or v_subscription.billing_cycle is distinct from v_snapshot.billing_cycle
     or v_subscription.updated_at is distinct from p_expected_updated_at
  then
    raise exception 'email_subscription_changed_retry' using errcode = '40001';
  end if;
  if v_subscription.status = 'expired' then
    raise exception 'email_subscription_expired' using errcode = '22023';
  end if;

  perform pg_catalog.set_config(
    'portal.email_subscription_rpc',
    'decision',
    true
  );

  v_previous_decision := v_subscription.lead_decision;

  update public.email_subscriptions
     set lead_decision = p_decision,
         lead_notes = nullif(btrim(p_notes), ''),
         lead_decision_by = v_actor_id,
         lead_decision_at = now(),
         status = p_decision
   where id = p_subscription_id;

  if p_decision = 'keep' then
    insert into public.email_subscriptions (
      project_id,
      project_name,
      email_provider,
      email_count,
      next_billing_date,
      billing_amount,
      currency,
      billing_cycle,
      status,
      created_by,
      notes
    )
    select v_subscription.project_id,
           v_subscription.project_name,
           v_subscription.email_provider,
           v_subscription.email_count,
           v_next_date,
           v_subscription.billing_amount,
           v_subscription.currency,
           v_subscription.billing_cycle,
           'active',
           v_subscription.created_by,
           v_subscription.notes
     where not exists (
       select 1
         from public.email_subscriptions subscription
        where lower(btrim(subscription.project_name)) = lower(btrim(v_subscription.project_name))
          and subscription.next_billing_date = v_next_date
     )
    returning id into v_next_id;
  elsif p_decision = 'cancel' and v_previous_decision = 'keep' then
    delete from public.email_subscriptions subscription
     where lower(btrim(subscription.project_name)) = lower(btrim(v_subscription.project_name))
       and subscription.next_billing_date = v_next_date
       and subscription.status = 'active';
    get diagnostics v_removed_next = row_count;
  end if;

  return jsonb_build_object(
    'subscriptionId', p_subscription_id,
    'decision', p_decision,
    'nextSubscriptionId', v_next_id,
    'removedNextCount', v_removed_next
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
    from public.payment_requests request
    left join public.projects project on project.id = request.project_id
    left join public.profiles decider on decider.id = request.decided_by
    left join public.profiles payer on payer.id = request.paid_by
   where request.id = p_request_id;
$$;

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
         request.updated_at
    from public.payment_requests request
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
        when v_existing.status = 'approved' then 'auto_approved'
        else 'approval_required'
      end
    );
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
    v_status := 'approved';
    v_approval_reason := null;
    v_outcome := 'auto_approved';
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
    )
  );

  v_summary := public.payment_request_month_summary(v_month);
  return jsonb_build_object(
    'request', public.payment_request_api_record(v_request_id),
    'summary', v_summary,
    'outcome', v_outcome
  );
end;
$$;

revoke all on function public.payment_request_cost_month_limit(date) from public, anon, authenticated;

revoke all on function public.email_subscription_amount_rub(numeric, text, date)
  from public, anon, authenticated;
revoke all on function public.assert_payment_cost_budget_month(date)
  from public, anon, authenticated;
revoke all on function public.enforce_payment_request_cost_budget()
  from public, anon, authenticated;
revoke all on function public.enforce_email_subscription_cost_budget()
  from public, anon, authenticated;
revoke all on function public.freeze_email_subscription_cost()
  from public, anon, authenticated;
revoke all on function public.protect_email_subscription_decision_fields()
  from public, anon, authenticated;
revoke all on function public.email_subscription_next_billing_date(date, text)
  from public, anon, authenticated;
revoke all on function public.lock_email_subscription_project_dates(text, date[])
  from public, anon, authenticated;

revoke all on function public.can_access_email_subscriptions()
  from public, anon, authenticated;
grant execute on function public.can_access_email_subscriptions() to authenticated;
revoke all on function public.can_manage_email_subscriptions()
  from public, anon, authenticated;
grant execute on function public.can_manage_email_subscriptions() to authenticated;
revoke all on function public.can_decide_email_subscriptions()
  from public, anon, authenticated;
grant execute on function public.can_decide_email_subscriptions() to authenticated;

revoke all on function public.record_email_subscription_payment_today(uuid, text, text, integer, numeric, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_email_subscription_payment_today(uuid, text, text, integer, numeric, text, text, text)
  to authenticated;

revoke all on function public.decide_email_subscription(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.decide_email_subscription(uuid, text, text, timestamptz)
  to authenticated;

revoke all on function public.list_payment_requests_with_budget(date) from public, anon, authenticated;
grant execute on function public.list_payment_requests_with_budget(date) to authenticated;

revoke all on function public.submit_payment_request_with_budget(uuid, text, text, numeric, uuid, text, text, text, text, date, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_payment_request_with_budget(uuid, text, text, numeric, uuid, text, text, text, text, date, text, text)
  to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select (budget_scope, cost_category) on table public.payment_requests to readonly';
  end if;
end;
$$;

comment on function public.payment_request_cost_month_limit(date) is
  'Company-wide monthly limit for costs: Instantly, email accounts, databases and domains.';
comment on column public.payment_requests.budget_scope is
  'Independent budget contour: general uses the legacy 75k/40k rules; costs uses the 650k monthly cap.';
comment on column public.payment_requests.cost_category is
  'Cost category. Email calendar rows are aggregated directly and are not copied into payment_requests.';
