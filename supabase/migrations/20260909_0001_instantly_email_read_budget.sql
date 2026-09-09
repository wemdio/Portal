-- Strict LIST /emails admission, shared by all Portal processes in a workspace.
-- Apply BEFORE deploying the matching client. No migration means fail-closed
-- technical deferral, not an unthrottled provider request or a negative lead.
-- Separate from the legacy fail-open token bucket used by other endpoints.
create table if not exists public.instantly_email_read_budget (
  account_id text primary key,
  reservations timestamptz[] not null default '{}',
  recovery_reservations timestamptz[] not null default '{}',
  cooldown_until timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

alter table public.instantly_email_read_budget enable row level security;
revoke all on table public.instantly_email_read_budget from public, anon, authenticated;
grant all on table public.instantly_email_read_budget to service_role;

comment on table public.instantly_email_read_budget is
  'Rolling 60-second LIST /emails reservations: at most 18 total and 6 recovery per workspace; shared 429 cooldown. API keys are never stored.';

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
  v_until timestamptz;
  v_wait_until timestamptz;
begin
  if p_account is null or length(btrim(p_account)) = 0 or length(p_account) > 128
      or p_priority is null or p_priority not in ('fresh', 'recovery') then
    raise exception 'invalid email read reservation';
  end if;

  insert into public.instantly_email_read_budget(account_id)
    values (p_account) on conflict (account_id) do nothing;
  select reservations, recovery_reservations, cooldown_until
    into v_all, v_recovery, v_until
    from public.instantly_email_read_budget where account_id = p_account for update;
  -- Take the clock AFTER acquiring the lock, not before a concurrent wait.
  v_now := clock_timestamp();

  select coalesce(array_agg(t order by t), '{}'::timestamptz[])
    into v_all from unnest(v_all) as t where t > v_now - interval '60 seconds';
  select coalesce(array_agg(t order by t), '{}'::timestamptz[])
    into v_recovery from unnest(v_recovery) as t where t > v_now - interval '60 seconds';

  if v_until > v_now then
    return jsonb_build_object('granted', false, 'reason', 'cooldown',
      'retry_after_ms', greatest(1, ceil(extract(epoch from (v_until - v_now)) * 1000)));
  end if;
  if cardinality(v_all) >= 18 then
    v_wait_until := v_all[1] + interval '60 seconds';
  end if;
  if p_priority = 'recovery' and cardinality(v_recovery) >= 6 then
    v_wait_until := greatest(v_wait_until, v_recovery[1] + interval '60 seconds');
  end if;
  if v_wait_until is null then
    v_all := array_append(v_all, v_now);
    if p_priority = 'recovery' then
      v_recovery := array_append(v_recovery, v_now);
    end if;
  end if;
  update public.instantly_email_read_budget
    set reservations = v_all, recovery_reservations = v_recovery,
        cooldown_until = null, updated_at = v_now
    where account_id = p_account;
  if v_wait_until is not null then
    return jsonb_build_object('granted', false, 'reason', 'budget',
      'retry_after_ms', greatest(1, ceil(extract(epoch from (v_wait_until - v_now)) * 1000)));
  end if;
  return jsonb_build_object('granted', true, 'retry_after_ms', 0);
end;
$$;

create or replace function public.instantly_defer_email_reads(
  p_account text,
  p_retry_after_ms bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz;
  v_until timestamptz;
begin
  if p_account is null or length(btrim(p_account)) = 0 or length(p_account) > 128
      or p_retry_after_ms is null or p_retry_after_ms < 1 then
    raise exception 'invalid email read cooldown';
  end if;
  insert into public.instantly_email_read_budget(account_id)
    values (p_account) on conflict (account_id) do nothing;
  select cooldown_until into v_until
    from public.instantly_email_read_budget where account_id = p_account for update;
  v_now := clock_timestamp();
  v_until := greatest(v_until, v_now + make_interval(secs => p_retry_after_ms::double precision / 1000));
  update public.instantly_email_read_budget
    set cooldown_until = v_until, updated_at = v_now where account_id = p_account;
  return jsonb_build_object('deferred', true,
    'retry_after_ms', greatest(1, ceil(extract(epoch from (v_until - v_now)) * 1000)));
end;
$$;

revoke all on function public.instantly_reserve_email_read(text, text) from public, anon, authenticated;
revoke all on function public.instantly_defer_email_reads(text, bigint) from public, anon, authenticated;
grant execute on function public.instantly_reserve_email_read(text, text) to service_role;
grant execute on function public.instantly_defer_email_reads(text, bigint) to service_role;

notify pgrst, 'reload schema';
