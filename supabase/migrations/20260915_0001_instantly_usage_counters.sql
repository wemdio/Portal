-- Instantly API usage accounting + LIST /emails budget lanes.
-- Apply BEFORE deploying the matching client. No migration means fail-closed
-- technical deferral for the new 'bulk' priority, not an unthrottled request.
--
-- Changes vs 20260909_0001:
--   1. Third admission priority 'bulk' for background bulk consumers
--      (emails export, replies report): its own 6/60s sub-share inside the
--      common 18/60s cap, so heavy exports can no longer starve fresh reply
--      discovery/qualification. fresh keeps up to the full 18 when idle.
--   2. Denial reasons are now specific: 'recovery_budget' / 'bulk_budget'
--      instead of a shared 'budget', so logs/counters can tell which lane
--      was exhausted. The generic 'budget' stays for the common 18/min cap.
--   3. Hourly usage counters (instantly_api_usage_hourly + bump RPC) for
--      per account × endpoint × consumer × status observability.

alter table public.instantly_email_read_budget
  add column if not exists bulk_reservations timestamptz[] not null default '{}';

comment on table public.instantly_email_read_budget is
  'Rolling 60-second LIST /emails reservations: at most 18 total, 6 recovery and 6 bulk per workspace; shared 429 cooldown. API keys are never stored.';

create or replace function public.instantly_reserve_email_read(
  p_account text,
  p_priority text default 'fresh'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz;
  v_all timestamptz[];
  v_recovery timestamptz[];
  v_bulk timestamptz[];
  v_until timestamptz;
  v_wait_until timestamptz;
  v_reason text;
begin
  if p_account is null or length(btrim(p_account)) = 0 or length(p_account) > 128
      or p_priority is null or p_priority not in ('fresh', 'recovery', 'bulk') then
    raise exception 'invalid email read reservation';
  end if;

  insert into public.instantly_email_read_budget(account_id)
    values (p_account) on conflict (account_id) do nothing;
  select reservations, recovery_reservations, bulk_reservations, cooldown_until
    into v_all, v_recovery, v_bulk, v_until
    from public.instantly_email_read_budget where account_id = p_account for update;
  -- Take the clock AFTER acquiring the lock, not before a concurrent wait.
  v_now := clock_timestamp();

  select coalesce(array_agg(t order by t), '{}'::timestamptz[])
    into v_all from unnest(v_all) as t where t > v_now - interval '60 seconds';
  select coalesce(array_agg(t order by t), '{}'::timestamptz[])
    into v_recovery from unnest(v_recovery) as t where t > v_now - interval '60 seconds';
  select coalesce(array_agg(t order by t), '{}'::timestamptz[])
    into v_bulk from unnest(v_bulk) as t where t > v_now - interval '60 seconds';

  if v_until > v_now then
    return jsonb_build_object('granted', false, 'reason', 'cooldown',
      'retry_after_ms', greatest(1, ceil(extract(epoch from (v_until - v_now)) * 1000)));
  end if;
  if cardinality(v_all) >= 18 then
    v_wait_until := v_all[1] + interval '60 seconds';
    v_reason := 'budget';
  end if;
  if p_priority = 'recovery' and cardinality(v_recovery) >= 6 then
    if v_wait_until is null or v_recovery[1] + interval '60 seconds' > v_wait_until then
      v_wait_until := v_recovery[1] + interval '60 seconds';
      v_reason := 'recovery_budget';
    end if;
  end if;
  if p_priority = 'bulk' and cardinality(v_bulk) >= 6 then
    if v_wait_until is null or v_bulk[1] + interval '60 seconds' > v_wait_until then
      v_wait_until := v_bulk[1] + interval '60 seconds';
      v_reason := 'bulk_budget';
    end if;
  end if;
  if v_wait_until is null then
    v_all := array_append(v_all, v_now);
    if p_priority = 'recovery' then
      v_recovery := array_append(v_recovery, v_now);
    end if;
    if p_priority = 'bulk' then
      v_bulk := array_append(v_bulk, v_now);
    end if;
  end if;
  update public.instantly_email_read_budget
    set reservations = v_all, recovery_reservations = v_recovery, bulk_reservations = v_bulk,
        cooldown_until = null, updated_at = v_now
    where account_id = p_account;
  if v_wait_until is not null then
    return jsonb_build_object('granted', false, 'reason', v_reason,
      'retry_after_ms', greatest(1, ceil(extract(epoch from (v_wait_until - v_now)) * 1000)));
  end if;
  return jsonb_build_object('granted', true, 'retry_after_ms', 0);
end;
$$;

create table if not exists public.instantly_api_usage_hourly (
  hour_utc timestamptz not null,
  account_id text not null,
  endpoint text not null,
  consumer text not null,
  status text not null,
  count bigint not null default 0,
  primary key (hour_utc, account_id, endpoint, consumer, status)
);

alter table public.instantly_api_usage_hourly enable row level security;
revoke all on table public.instantly_api_usage_hourly from public, anon, authenticated;
grant all on table public.instantly_api_usage_hourly to service_role;

comment on table public.instantly_api_usage_hourly is
  'Hourly Instantly API attempt/deferral counters per account × endpoint × consumer × status. Aggregated upserts; rows older than 35 days are purged opportunistically by the bump RPC.';

create or replace function public.instantly_bump_api_usage(
  p_hour timestamptz,
  p_account text,
  p_endpoint text,
  p_consumer text,
  p_status text,
  p_count bigint default 1
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_hour is null or p_account is null or length(btrim(p_account)) = 0 or length(p_account) > 128
      or p_endpoint is null or length(p_endpoint) = 0 or length(p_endpoint) > 128
      or p_consumer is null or length(p_consumer) = 0 or length(p_consumer) > 128
      or p_status is null or length(p_status) = 0 or length(p_status) > 64
      or p_count is null or p_count < 1 or p_count > 100000 then
    raise exception 'invalid api usage counter';
  end if;
  insert into public.instantly_api_usage_hourly(hour_utc, account_id, endpoint, consumer, status, count)
    values (date_trunc('hour', p_hour), p_account, p_endpoint, p_consumer, p_status, p_count)
    on conflict (hour_utc, account_id, endpoint, consumer, status)
    do update set count = public.instantly_api_usage_hourly.count + excluded.count;
  -- Opportunistic retention: ~2% of bumps trim rows beyond 35 days.
  if random() < 0.02 then
    delete from public.instantly_api_usage_hourly where hour_utc < now() - interval '35 days';
  end if;
end;
$$;

revoke all on function public.instantly_reserve_email_read(text, text) from public, anon, authenticated;
revoke all on function public.instantly_bump_api_usage(timestamptz, text, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.instantly_reserve_email_read(text, text) to service_role;
grant execute on function public.instantly_bump_api_usage(timestamptz, text, text, text, text, bigint) to service_role;

notify pgrst, 'reload schema';
