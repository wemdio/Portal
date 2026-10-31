-- The migration runner wraps this file in a transaction. Freeze old writers
-- while seeding the shared minute ledger, without resetting account history.
lock table public.eng_tinyfish_budget in share row exclusive mode;

-- '@' cannot occur in an operator account ID. Keep an existing ledger intact.
insert into public.eng_tinyfish_budget(account_id, reservations)
select '@eng-tinyfish-minute', coalesce(array_agg(t order by t), '{}'::timestamptz[])
from public.eng_tinyfish_budget as b
cross join lateral unnest(b.reservations) as t
where b.account_id ~ '^[a-zA-Z0-9._-]{1,80}$'
  and t > clock_timestamp() - interval '1 minute'
on conflict (account_id) do nothing;

create or replace function public.eng_tinyfish_reserve_url(p_account text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz;
  v_all timestamptz[];
  v_pool timestamptz[];
  v_minute integer;
begin
  if p_account is null or p_account !~ '^[a-zA-Z0-9._-]{1,80}$' then
    raise exception 'invalid TinyFish account id';
  end if;

  -- Every caller, including older workers, locks in the same global-first order.
  select reservations into v_pool from public.eng_tinyfish_budget
    where account_id = '@eng-tinyfish-minute' for update;
  if not found then
    raise exception 'TinyFish shared minute budget is unavailable';
  end if;
  insert into public.eng_tinyfish_budget(account_id) values (p_account)
    on conflict (account_id) do nothing;
  select reservations into v_all from public.eng_tinyfish_budget
    where account_id = p_account for update;
  if not found then
    raise exception 'TinyFish account budget is unavailable';
  end if;
  v_now := clock_timestamp();

  select coalesce(array_agg(t order by t), '{}'::timestamptz[]) into v_pool
    from unnest(v_pool) as t where t > v_now - interval '1 minute';
  select coalesce(array_agg(t order by t), '{}'::timestamptz[]) into v_all
    from unnest(v_all) as t where t > v_now - interval '24 hours';
  select count(*) into v_minute from unnest(v_all) as t
    where t > v_now - interval '1 minute';

  -- A shared rate refusal must not be mistaken for a switchable daily quota.
  if cardinality(v_pool) >= 120 or v_minute >= 120 then
    return jsonb_build_object('granted', false, 'budget_version', 2,
      'reason', 'minute_exhausted');
  end if;
  if cardinality(v_all) >= 1000 then
    return jsonb_build_object('granted', false, 'budget_version', 2,
      'reason', 'daily_exhausted');
  end if;

  update public.eng_tinyfish_budget
    set reservations = array_append(v_pool, v_now), updated_at = v_now
    where account_id = '@eng-tinyfish-minute';
  update public.eng_tinyfish_budget
    set reservations = array_append(v_all, v_now), updated_at = v_now
    where account_id = p_account;
  return jsonb_build_object('granted', true, 'budget_version', 2);
end;
$$;
