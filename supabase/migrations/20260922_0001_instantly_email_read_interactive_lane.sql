-- LIST /emails budget: a guaranteed share for reads a person is waiting on.
-- Apply BEFORE deploying the matching client. Without this migration the new
-- 'interactive' priority is rejected by the function and every interactive
-- read fails closed as storage_unavailable (the thread card then shows only the
-- requested email and retries) — degraded, never an unthrottled request.
--
-- Why: the 18/60s workspace cap is shared by the reply workers (discovery,
-- qualification, ownership) and by screens where a human waits (open a thread,
-- reply, forward). 'fresh' had no sub-cap, so a qualification burst took all 18
-- slots and the cabinet got "email read deferred: budget" — 15 thread 502s in
-- the week of 14.09 (sales complaint «не находит треды»). 102 of 168 hours in
-- the last 7 days had at least one deferral.
--
-- Changes vs 20260915_0001:
--   1. Fourth priority 'interactive' for single, human-triggered reads.
--   2. Reserved headroom: non-interactive priorities (fresh, recovery, bulk)
--      together may hold at most 15 of the 18 slots, so 3 per minute are always
--      free for a person. Measured need: peak 26 thread opens per hour
--      (<1 per minute); 3 covers a burst of clicks. Cost to the workers: at most
--      3 slots in a saturated minute; their daily volume (avg ~5/min) is far
--      below the cap, so work is delayed, not lost.
--   3. Interactive has its own 6/60s ceiling, like recovery and bulk: a broken
--      client refresh loop cannot starve the reply workers. Denial reason
--      'interactive_budget'.
--   The common 18/60s cap and the 429 cooldown are unchanged: the provider
--   never sees more than before.

alter table public.instantly_email_read_budget
  add column if not exists interactive_reservations timestamptz[] not null default '{}';

comment on table public.instantly_email_read_budget is
  'Rolling 60-second LIST /emails reservations: at most 18 total per workspace, of which non-interactive priorities hold at most 15 (3 kept for interactive); sub-shares of 6 each for recovery, bulk and interactive; shared 429 cooldown. API keys are never stored.';

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
  c_total_cap constant int := 18;
  c_interactive_reserved constant int := 3;
  c_lane_cap constant int := 6;
  v_now timestamptz;
  v_all timestamptz[];
  v_recovery timestamptz[];
  v_bulk timestamptz[];
  v_interactive timestamptz[];
  v_background timestamptz[];
  v_until timestamptz;
  v_wait_until timestamptz;
  v_reason text;
begin
  if p_account is null or length(btrim(p_account)) = 0 or length(p_account) > 128
      or p_priority is null or p_priority not in ('fresh', 'recovery', 'bulk', 'interactive') then
    raise exception 'invalid email read reservation';
  end if;

  insert into public.instantly_email_read_budget(account_id)
    values (p_account) on conflict (account_id) do nothing;
  select reservations, recovery_reservations, bulk_reservations, interactive_reservations, cooldown_until
    into v_all, v_recovery, v_bulk, v_interactive, v_until
    from public.instantly_email_read_budget where account_id = p_account for update;
  -- Take the clock AFTER acquiring the lock, not before a concurrent wait.
  v_now := clock_timestamp();

  select coalesce(array_agg(t order by t), '{}'::timestamptz[])
    into v_all from unnest(v_all) as t where t > v_now - interval '60 seconds';
  select coalesce(array_agg(t order by t), '{}'::timestamptz[])
    into v_recovery from unnest(v_recovery) as t where t > v_now - interval '60 seconds';
  select coalesce(array_agg(t order by t), '{}'::timestamptz[])
    into v_bulk from unnest(v_bulk) as t where t > v_now - interval '60 seconds';
  select coalesce(array_agg(t order by t), '{}'::timestamptz[])
    into v_interactive from unnest(v_interactive) as t where t > v_now - interval '60 seconds';
  -- Every reservation lands in v_all; interactive ones are also in
  -- v_interactive. Timestamps are taken under the row lock, so they do not
  -- collide across lanes and set difference is exact.
  select coalesce(array_agg(t order by t), '{}'::timestamptz[])
    into v_background from unnest(v_all) as t where t <> all(v_interactive);

  if v_until > v_now then
    return jsonb_build_object('granted', false, 'reason', 'cooldown',
      'retry_after_ms', greatest(1, ceil(extract(epoch from (v_until - v_now)) * 1000)));
  end if;
  if cardinality(v_all) >= c_total_cap then
    v_wait_until := v_all[1] + interval '60 seconds';
    v_reason := 'budget';
  end if;
  -- Reserved headroom: background may not take the last slots a person needs.
  if p_priority <> 'interactive'
      and cardinality(v_background) >= c_total_cap - c_interactive_reserved then
    if v_wait_until is null or v_background[1] + interval '60 seconds' > v_wait_until then
      v_wait_until := v_background[1] + interval '60 seconds';
      v_reason := 'budget';
    end if;
  end if;
  if p_priority = 'recovery' and cardinality(v_recovery) >= c_lane_cap then
    if v_wait_until is null or v_recovery[1] + interval '60 seconds' > v_wait_until then
      v_wait_until := v_recovery[1] + interval '60 seconds';
      v_reason := 'recovery_budget';
    end if;
  end if;
  if p_priority = 'bulk' and cardinality(v_bulk) >= c_lane_cap then
    if v_wait_until is null or v_bulk[1] + interval '60 seconds' > v_wait_until then
      v_wait_until := v_bulk[1] + interval '60 seconds';
      v_reason := 'bulk_budget';
    end if;
  end if;
  if p_priority = 'interactive' and cardinality(v_interactive) >= c_lane_cap then
    if v_wait_until is null or v_interactive[1] + interval '60 seconds' > v_wait_until then
      v_wait_until := v_interactive[1] + interval '60 seconds';
      v_reason := 'interactive_budget';
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
    if p_priority = 'interactive' then
      v_interactive := array_append(v_interactive, v_now);
    end if;
  end if;
  update public.instantly_email_read_budget
    set reservations = v_all, recovery_reservations = v_recovery, bulk_reservations = v_bulk,
        interactive_reservations = v_interactive, cooldown_until = null, updated_at = v_now
    where account_id = p_account;
  if v_wait_until is not null then
    return jsonb_build_object('granted', false, 'reason', v_reason,
      'retry_after_ms', greatest(1, ceil(extract(epoch from (v_wait_until - v_now)) * 1000)));
  end if;
  return jsonb_build_object('granted', true, 'retry_after_ms', 0);
end;
$$;

revoke all on function public.instantly_reserve_email_read(text, text) from public, anon, authenticated;
grant execute on function public.instantly_reserve_email_read(text, text) to service_role;

notify pgrst, 'reload schema';
