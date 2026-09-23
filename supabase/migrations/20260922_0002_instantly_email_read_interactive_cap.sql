-- LIST /emails budget: raise the interactive ceiling from 6 to 15 per 60 s.
-- Supersedes the interactive cap of 20260922_0001 (same deploy; 0001 was never
-- applied anywhere when this was written). Apply BEFORE the matching client —
-- the pipeline does it (ensureDatabase.js preflight).
--
-- Why: 0001 sized the human share from the HOURLY peak (26 thread opens per
-- hour), but people open threads in bursts. nginx 05.09–22.09: up to 14 reads in
-- a sliding 60 s, p99 12–13, always ONE person paging through replies
-- (account-2 client cabinet, staff in reply-personalization). With a 6/60 s cap,
-- opens #7+ of such a burst were denied 'interactive_budget' even on account-2,
-- where background is light (p90 ~3/min) and before 0001 the person had nearly
-- all 18 slots. Replaying account-2's 355 thread opens against 6/60 s: 88 would
-- load partially (vs 20 hard 502s before) — worse than no lane at all.
--
-- New shape, symmetric:
--   * background (fresh + recovery + bulk) ≤ 15  → ≥3 slots always free for a
--     person (unchanged from 0001);
--   * interactive ≤ 15                          → ≥3 slots always left for the
--     reply workers even if a client screen loops;
--   * total ≤ 18 and the 429 cooldown           → unchanged, the provider sees
--     no more than before.
-- For a person this is not worse than before 0001 at any measured load: when
-- background uses fewer than 15, they get 18 − background as before (capped at
-- 15, above the measured single-person peak of 14); when background is
-- saturated they get 3 instead of 0.

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
  c_interactive_cap constant int := 15;
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
  if p_priority = 'interactive' and cardinality(v_interactive) >= c_interactive_cap then
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

comment on table public.instantly_email_read_budget is
  'Rolling 60-second LIST /emails reservations: at most 18 total per workspace; non-interactive priorities hold at most 15 and interactive at most 15 (each side keeps 3 for the other); sub-shares of 6 for recovery and bulk; shared 429 cooldown. API keys are never stored.';

notify pgrst, 'reload schema';
