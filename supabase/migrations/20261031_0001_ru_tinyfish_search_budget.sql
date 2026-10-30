-- Dedicated Search admission for the RU quota account. Fetch remains metered
-- separately. Never store API keys, search queries, URLs, or client data here.
create table if not exists public.ru_tinyfish_search_budget (
  account_id text primary key,
  reservations timestamptz[] not null default '{}',
  updated_at timestamptz not null default clock_timestamp()
);

alter table public.ru_tinyfish_search_budget enable row level security;
revoke all on table public.ru_tinyfish_search_budget from public, anon, authenticated;
grant all on table public.ru_tinyfish_search_budget to service_role;

create or replace function public.ru_tinyfish_reserve_search(p_account text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz;
  v_all timestamptz[];
  v_minute integer;
  v_hour integer;
begin
  if p_account is null or p_account !~ '^[a-zA-Z0-9._-]{1,80}$' then
    raise exception 'invalid TinyFish account id';
  end if;
  insert into public.ru_tinyfish_search_budget(account_id) values (p_account)
    on conflict (account_id) do nothing;
  select reservations into v_all from public.ru_tinyfish_search_budget
    where account_id = p_account for update;
  if not found then
    raise exception 'TinyFish Search budget is unavailable';
  end if;
  -- Evaluate the rolling windows after obtaining the shared account lock.
  v_now := clock_timestamp();
  select coalesce(array_agg(t order by t), '{}'::timestamptz[]) into v_all
    from unnest(v_all) as t where t > v_now - interval '24 hours';
  select count(*) filter (where t > v_now - interval '1 minute'),
    count(*) filter (where t > v_now - interval '1 hour')
    into v_minute, v_hour from unnest(v_all) as t;
  if cardinality(v_all) >= 12000 or v_hour >= 500 or v_minute >= 30 then
    return jsonb_build_object('granted', false, 'budget_version', 1);
  end if;
  update public.ru_tinyfish_search_budget
    set reservations = array_append(v_all, v_now), updated_at = v_now
    where account_id = p_account;
  return jsonb_build_object('granted', true, 'budget_version', 1);
end;
$$;
revoke all on function public.ru_tinyfish_reserve_search(text) from public, anon, authenticated;
grant execute on function public.ru_tinyfish_reserve_search(text) to service_role;
notify pgrst, 'reload schema';
