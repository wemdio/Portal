-- Raise the shared free Fetch ceiling without resetting existing reservations.
-- The minute ceiling and function privileges remain unchanged.
create or replace function public.eng_tinyfish_reserve_url(p_account text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz;
  v_all timestamptz[];
  v_minute integer;
begin
  if p_account is null or p_account !~ '^[a-zA-Z0-9._-]{1,80}$' then
    raise exception 'invalid TinyFish account id';
  end if;
  insert into public.eng_tinyfish_budget(account_id) values (p_account)
    on conflict (account_id) do nothing;
  select reservations into v_all from public.eng_tinyfish_budget
    where account_id = p_account for update;
  v_now := clock_timestamp();
  select coalesce(array_agg(t order by t), '{}'::timestamptz[]) into v_all
    from unnest(v_all) as t where t > v_now - interval '24 hours';
  select count(*) into v_minute from unnest(v_all) as t
    where t > v_now - interval '1 minute';
  -- Stay within the free daily quota and retain minute-rate headroom.
  if cardinality(v_all) >= 1000 or v_minute >= 120 then
    return jsonb_build_object('granted', false);
  end if;
  update public.eng_tinyfish_budget
    set reservations = array_append(v_all, v_now), updated_at = v_now
    where account_id = p_account;
  return jsonb_build_object('granted', true);
end;
$$;
