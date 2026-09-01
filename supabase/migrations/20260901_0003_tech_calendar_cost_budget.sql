-- Technician-calendar costs in the separate 650k company-cost budget.
--
-- Only a current row explicitly marked `keep` contributes. Its RUB value is
-- frozen when the decision is made: before the billing date it is reserved,
-- on/after the date it is fact. Renewal moves the completed cycle into an
-- append-only ledger, so advancing the recurring row cannot erase history.

alter table public.tech_subscriptions
  add column if not exists cost_amount_rub numeric(12, 2),
  drop constraint if exists tech_subscriptions_amount_nonnegative,
  drop constraint if exists tech_subscriptions_cost_amount_rub_nonnegative;

alter table public.tech_subscriptions
  add constraint tech_subscriptions_amount_nonnegative
    check (amount >= 0 and amount <> 'NaN'::numeric),
  add constraint tech_subscriptions_cost_amount_rub_nonnegative
    check (
      cost_amount_rub is null
      or (cost_amount_rub >= 0 and cost_amount_rub <> 'NaN'::numeric)
    );

-- Backfill what can be established from historical FX. A missing historical
-- rate intentionally leaves NULL: the summary then becomes incomplete and all
-- budget-increasing writes fail closed rather than treating the charge as zero.
update public.tech_subscriptions subscription
   set cost_amount_rub = public.email_subscription_amount_rub(
     subscription.amount,
     subscription.currency,
     subscription.next_billing_date
   )
 where subscription.status = 'keep'
   and subscription.cost_amount_rub is null;

create or replace function public.freeze_tech_subscription_cost()
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
     and new.amount is not distinct from old.amount
     and upper(new.currency) is not distinct from upper(old.currency)
     and new.next_billing_date is not distinct from old.next_billing_date
  then
    -- The frozen value is derived, never caller-controlled.
    new.cost_amount_rub := old.cost_amount_rub;
    return new;
  end if;

  v_amount_rub := public.email_subscription_amount_rub(
    new.amount,
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


drop trigger if exists tech_subscriptions_freeze_cost on public.tech_subscriptions;
create trigger tech_subscriptions_freeze_cost
  before insert or update on public.tech_subscriptions
  for each row
  execute function public.freeze_tech_subscription_cost();

create table if not exists public.tech_subscription_cost_events (
  id uuid primary key default gen_random_uuid(),

  -- Snapshot key, deliberately not an FK: deleting an obsolete calendar row
  -- must not delete or block deletion because of immutable payment history.
  subscription_id uuid not null,
  billing_date date not null,
  service_name text not null,
  service_type text not null,
  billing_cycle text not null,
  amount numeric(12, 2) not null,
  currency text not null,
  amount_rub numeric(12, 2) not null,
  paid_at timestamptz not null default now(),
  paid_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint tech_subscription_cost_events_service_type_check
    check (service_type in ('proxy', 'server', 'api', 'software', 'other')),
  constraint tech_subscription_cost_events_billing_cycle_check
    check (billing_cycle in ('monthly', 'quarterly', 'yearly')),
  constraint tech_subscription_cost_events_currency_check
    check (currency in ('RUB', 'USD')),
  constraint tech_subscription_cost_events_amount_nonnegative
    check (amount >= 0 and amount <> 'NaN'::numeric),
  constraint tech_subscription_cost_events_amount_rub_nonnegative
    check (amount_rub >= 0 and amount_rub <> 'NaN'::numeric),
  unique (subscription_id, billing_date)
);

create index if not exists idx_tech_subscription_cost_events_billing_date
  on public.tech_subscription_cost_events (billing_date);

alter table public.tech_subscription_cost_events enable row level security;
revoke all on table public.tech_subscription_cost_events from public, anon, authenticated;
grant select, insert on table public.tech_subscription_cost_events to service_role;

create or replace function public.protect_tech_subscription_cost_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- `paid_by` is the only field that may be cleared, and only by the nested
  -- FK action produced by deleting the referenced profile. Direct updates,
  -- including otherwise-identical `paid_by = null` writes, remain forbidden.
  if tg_op = 'UPDATE'
     and pg_catalog.pg_trigger_depth() > 1
     and new.paid_by is null
     and old.paid_by is not null
     and (to_jsonb(new) - 'paid_by') is not distinct from (to_jsonb(old) - 'paid_by')
  then
    return new;
  end if;

  raise exception 'tech_subscription_cost_events_append_only' using errcode = '55000';
end;
$$;

drop trigger if exists tech_subscription_cost_events_append_only
  on public.tech_subscription_cost_events;
create trigger tech_subscription_cost_events_append_only
  before update or delete on public.tech_subscription_cost_events
  for each row
  execute function public.protect_tech_subscription_cost_events();

create or replace function public.protect_tech_subscription_paid_cycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Europe/Moscow')::date;
begin
  -- Keep profile deletion possible without opening a general edit path for a
  -- paid cycle. The two profile FKs use ON DELETE SET NULL; their nested
  -- updates may only clear those references and must leave every other field
  -- unchanged. The ordinary service-role API still cannot use this exception.
  if tg_op = 'UPDATE'
     and pg_catalog.pg_trigger_depth() > 1
     and (
       new.decision_by is not distinct from old.decision_by
       or (old.decision_by is not null and new.decision_by is null)
     )
     and (
       new.created_by is not distinct from old.created_by
       or (old.created_by is not null and new.created_by is null)
     )
     and (
       new.decision_by is distinct from old.decision_by
       or new.created_by is distinct from old.created_by
     )
     and (to_jsonb(new) - 'decision_by' - 'created_by')
       is not distinct from (to_jsonb(old) - 'decision_by' - 'created_by')
  then
    return new;
  end if;

  -- Once an accepted cycle reaches its billing date it is already reported as
  -- fact. It may only be advanced after renewal has first archived that exact
  -- cycle; ordinary edit/cancel/delete paths must not rewrite paid history.
  if tg_op <> 'INSERT'
     and old.status = 'keep'
     and old.next_billing_date <= v_today
     and not exists (
       select 1
         from public.tech_subscription_cost_events event
        where event.subscription_id = old.id
          and event.billing_date = old.next_billing_date
     )
  then
    raise exception 'tech_subscription_paid_cycle_locked' using errcode = '55000';
  end if;

  -- A recurring live row may never point back at a cycle that is already in
  -- the immutable ledger. Without this guard the summary anti-join would hide
  -- the live row and the next renewal would fail on the ledger unique key.
  if tg_op <> 'DELETE'
     and new.status = 'keep'
     and exists (
       select 1
         from public.tech_subscription_cost_events event
        where event.subscription_id = new.id
          and event.billing_date = new.next_billing_date
     )
  then
    raise exception 'tech_subscription_cycle_already_archived' using errcode = '23505';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists tech_subscriptions_protect_paid_cycle
  on public.tech_subscriptions;
create trigger tech_subscriptions_protect_paid_cycle
  before insert or update or delete on public.tech_subscriptions
  for each row
  execute function public.protect_tech_subscription_paid_cycle();

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
      from public.payment_requests request
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

-- One guard implementation serves both live rows and ledger rows. Every
-- budget-increasing month is locked in sorted order and rechecked against the
-- complete cross-source summary.
create or replace function public.enforce_tech_calendar_cost_budget()
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
  if tg_table_name = 'tech_subscriptions' then
    if tg_op <> 'INSERT' and old.status = 'keep' then
      v_old_month := date_trunc('month', old.next_billing_date)::date;
      v_old_amount := old.cost_amount_rub;
    end if;

    if tg_op <> 'DELETE' and new.status = 'keep' then
      v_new_month := date_trunc('month', new.next_billing_date)::date;
      v_new_amount := new.cost_amount_rub;
    end if;
  elsif tg_table_name = 'tech_subscription_cost_events' then
    if tg_op <> 'INSERT' then
      v_old_month := date_trunc('month', old.billing_date)::date;
      v_old_amount := old.amount_rub;
    end if;

    if tg_op <> 'DELETE' then
      v_new_month := date_trunc('month', new.billing_date)::date;
      if tg_op = 'INSERT' then
        -- Renewal archives the same accepted live cycle before advancing its
        -- recurring row. Only the amount above that matching live charge is a
        -- real budget increase; equal snapshots are a net-zero transfer.
        select event.amount_rub - coalesce(subscription.cost_amount_rub, 0)
          into v_new_amount
          from (
            values (new.subscription_id, new.billing_date, new.amount_rub)
          ) as event(subscription_id, billing_date, amount_rub)
          left join public.tech_subscriptions subscription
            on subscription.id = event.subscription_id
           and subscription.status = 'keep'
           and subscription.next_billing_date = event.billing_date;
      else
        v_new_amount := new.amount_rub;
      end if;
    end if;
  else
    raise exception 'tech_subscription_budget_guard_invalid_table' using errcode = 'P0001';
  end if;

  v_lock_months := array[v_old_month, v_new_month];
  perform public.lock_payment_request_months(v_lock_months);

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
    -- assert_payment_cost_budget_month fails closed with
    -- payment_request_cost_budget_incomplete and rejects an over-cap month with
    -- payment_request_cost_limit_exceeded.
    perform public.assert_payment_cost_budget_month(v_month);
  end loop;

  return null;
end;
$$;

drop trigger if exists tech_subscriptions_cost_budget_guard
  on public.tech_subscriptions;
create constraint trigger tech_subscriptions_cost_budget_guard
  after insert or update or delete on public.tech_subscriptions
  deferrable initially immediate
  for each row
  execute function public.enforce_tech_calendar_cost_budget();

drop trigger if exists tech_subscription_cost_events_budget_guard
  on public.tech_subscription_cost_events;
create constraint trigger tech_subscription_cost_events_budget_guard
  after insert or update or delete on public.tech_subscription_cost_events
  deferrable initially immediate
  for each row
  execute function public.enforce_tech_calendar_cost_budget();

create or replace function public.renew_tech_subscription_with_budget(
  p_subscription_id uuid,
  p_next_billing_date date,
  p_next_amount numeric,
  p_actor_id uuid,
  p_expected_updated_at timestamptz
)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscription public.tech_subscriptions%rowtype;
  v_next_amount numeric;
  v_today date := (now() at time zone 'Europe/Moscow')::date;
begin
  if p_subscription_id is null
     or p_next_billing_date is null
     or p_actor_id is null
     or p_expected_updated_at is null
     or (
       p_next_amount is not null
       and (
         p_next_amount < 0
         or p_next_amount = 'NaN'::numeric
         or p_next_amount > 9999999999.99
         or p_next_amount <> round(p_next_amount, 2)
       )
     )
  then
    raise exception 'tech_subscription_invalid_input' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.profiles actor
     where actor.id = p_actor_id
       and coalesce(actor.is_demo, false) = false
       and actor.role in ('admin', 'director')
  ) then
    raise exception 'tech_subscription_invalid_input' using errcode = '22023';
  end if;

  -- Serialize retries for this card before taking the row lock. The optimistic
  -- timestamp then makes a stale browser request a clear, harmless conflict.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'tech_subscription_renewal:' || p_subscription_id::text,
      0
    )
  );

  select subscription.*
    into v_subscription
    from public.tech_subscriptions subscription
   where subscription.id = p_subscription_id
   for update;

  if not found then
    raise exception 'tech_subscription_not_found' using errcode = 'P0002';
  end if;
  if v_subscription.updated_at is distinct from p_expected_updated_at then
    raise exception 'tech_subscription_conflict' using errcode = '40001';
  end if;
  if v_subscription.status <> 'keep'
     or v_subscription.next_billing_date > v_today
     or p_next_billing_date <= v_subscription.next_billing_date
  then
    raise exception 'tech_subscription_invalid_input' using errcode = '22023';
  end if;
  if v_subscription.cost_amount_rub is null then
    raise exception 'payment_request_cost_budget_incomplete' using errcode = 'P0001';
  end if;

  v_next_amount := coalesce(p_next_amount, v_subscription.amount);

  -- Archive first. The ledger budget guard subtracts the still-present matching
  -- live charge, making this an exact net-zero transfer even when the month is
  -- already over limit or another calendar source has incomplete FX data. The
  -- paid-cycle guard then permits only the matching advance below. The shared
  -- guard still propagates payment_request_cost_limit_exceeded for any genuine
  -- positive ledger delta rather than letting an unmatched write bypass the cap.
  insert into public.tech_subscription_cost_events (
    subscription_id,
    billing_date,
    service_name,
    service_type,
    billing_cycle,
    amount,
    currency,
    amount_rub,
    paid_at,
    paid_by
  ) values (
    v_subscription.id,
    v_subscription.next_billing_date,
    v_subscription.service_name,
    v_subscription.service_type,
    v_subscription.billing_cycle,
    v_subscription.amount,
    v_subscription.currency,
    v_subscription.cost_amount_rub,
    now(),
    p_actor_id
  );

  update public.tech_subscriptions
     set next_billing_date = p_next_billing_date,
         amount = v_next_amount,
         status = 'active',
         cost_amount_rub = null,
         decision_by = null,
         decision_at = null,
         decision_notes = null
   where id = p_subscription_id;

  return p_next_billing_date;
end;
$$;

revoke all on function public.freeze_tech_subscription_cost()
  from public, anon, authenticated;
revoke all on function public.protect_tech_subscription_cost_events()
  from public, anon, authenticated;
revoke all on function public.protect_tech_subscription_paid_cycle()
  from public, anon, authenticated;
revoke all on function public.enforce_tech_calendar_cost_budget()
  from public, anon, authenticated;
revoke all on function public.renew_tech_subscription_with_budget(uuid, date, numeric, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.renew_tech_subscription_with_budget(uuid, date, numeric, uuid, timestamptz)
  to service_role;

comment on column public.tech_subscriptions.cost_amount_rub is
  'Frozen RUB value while status=keep; NULL for rows outside the company-cost budget.';
comment on table public.tech_subscription_cost_events is
  'Append-only paid technician-calendar cycles. Subscription id is a snapshot key, not an FK, so deleting a calendar card preserves history.';
comment on function public.renew_tech_subscription_with_budget(uuid, date, numeric, uuid, timestamptz) is
  'Atomically archives the accepted current cycle as paid and advances the recurring technician-calendar row under the company-cost cap.';
