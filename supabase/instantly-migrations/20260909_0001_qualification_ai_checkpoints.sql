-- Durable accounting is intentionally sealed behind RPCs. A reservation counts
-- BEFORE HTTP, including crashed/unknown attempts; days and leases never reset it.
-- grants-lint: no-service-role-grant public.instantly_qualification_ai_budgets — sealed RPC-only paid-attempt accounting
create table if not exists public.instantly_qualification_ai_budgets (
  budget_key text primary key check (budget_key ~ '^[a-f0-9]{64}$'),
  attempts integer not null default 0 check (attempts between 0 and 3),
  cooldown_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- No original prompts or API keys. Raw model output may contain customer-derived
-- text, so even reads are restricted to the trusted worker RPCs.
-- grants-lint: no-service-role-grant public.instantly_qualification_ai_checkpoints — sealed RPC-only qualification output cache
create table if not exists public.instantly_qualification_ai_checkpoints (
  checkpoint_key text primary key check (checkpoint_key ~ '^[a-f0-9]{64}$'),
  budget_key text not null references public.instantly_qualification_ai_budgets(budget_key),
  attempts integer not null default 0 check (attempts between 0 and 3),
  raw_response text check (raw_response is null or octet_length(raw_response) <= 65536),
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.instantly_qualification_ai_budgets enable row level security;
alter table public.instantly_qualification_ai_checkpoints enable row level security;

create or replace function public.reserve_instantly_qualification_ai(
  p_checkpoint_key text, p_budget_key text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_budget public.instantly_qualification_ai_budgets%rowtype;
  v_checkpoint public.instantly_qualification_ai_checkpoints%rowtype;
  v_token uuid;
begin
  if p_checkpoint_key is null or p_budget_key is null
     or p_checkpoint_key !~ '^[a-f0-9]{64}$' or p_budget_key !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid qualification checkpoint key';
  end if;
  insert into public.instantly_qualification_ai_budgets(budget_key)
    values(p_budget_key) on conflict do nothing;
  select * into strict v_budget from public.instantly_qualification_ai_budgets
    where budget_key = p_budget_key for update;
  insert into public.instantly_qualification_ai_checkpoints(checkpoint_key, budget_key)
    values(p_checkpoint_key, p_budget_key) on conflict do nothing;
  select * into strict v_checkpoint from public.instantly_qualification_ai_checkpoints
    where checkpoint_key = p_checkpoint_key for update;
  if v_checkpoint.budget_key <> p_budget_key then
    raise exception 'Qualification checkpoint budget mismatch';
  end if;
  if v_checkpoint.raw_response is not null then
    return jsonb_build_object('state', 'cached', 'raw_response', v_checkpoint.raw_response);
  end if;
  if v_budget.cooldown_until > clock_timestamp() then
    return jsonb_build_object('state', 'busy');
  end if;
  if v_checkpoint.lease_token is not null and v_checkpoint.lease_until > clock_timestamp() then
    return jsonb_build_object('state', 'busy');
  end if;
  if v_budget.attempts >= 3 then
    return jsonb_build_object('state', 'exhausted');
  end if;
  v_token := gen_random_uuid();
  update public.instantly_qualification_ai_budgets
    set attempts = attempts + 1, updated_at = clock_timestamp() where budget_key = p_budget_key;
  update public.instantly_qualification_ai_checkpoints
    set attempts = attempts + 1, lease_token = v_token,
        lease_until = clock_timestamp() + interval '2 minutes', updated_at = clock_timestamp()
    where checkpoint_key = p_checkpoint_key;
  return jsonb_build_object('state', 'reserved', 'lease_token', v_token);
end;
$$;

create or replace function public.finish_instantly_qualification_ai(
  p_checkpoint_key text, p_lease_token uuid, p_raw_response text, p_error_code text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_budget_key text;
  v_checkpoint public.instantly_qualification_ai_checkpoints%rowtype;
begin
  if p_raw_response is not null and
     (length(p_raw_response) = 0 or octet_length(p_raw_response) > 65536) then
    raise exception 'Invalid qualification checkpoint response';
  end if;
  select budget_key into v_budget_key from public.instantly_qualification_ai_checkpoints
    where checkpoint_key = p_checkpoint_key;
  if v_budget_key is null then return jsonb_build_object('state', 'lease_lost'); end if;
  -- The same lock order as reserve prevents cross-pass/concurrent deadlocks.
  perform 1 from public.instantly_qualification_ai_budgets where budget_key = v_budget_key for update;
  select * into strict v_checkpoint from public.instantly_qualification_ai_checkpoints
    where checkpoint_key = p_checkpoint_key for update;
  if p_lease_token is null or v_checkpoint.lease_token is distinct from p_lease_token then
    return jsonb_build_object('state', 'lease_lost');
  end if;
  -- A completed explicit no-credit/rate-limit rejection produced no paid model
  -- output. Refund ONLY these known outcomes, never a network-uncertain crash,
  -- timeout, truncated/invalid JSON or a provider/server error. Persist cooldown
  -- so a balance outage cannot either poison the lifetime cap or busy-loop.
  if p_raw_response is null and p_error_code in ('http_402', 'http_429') then
    update public.instantly_qualification_ai_budgets
      set attempts = attempts - 1,
          cooldown_until = clock_timestamp() + case when p_error_code = 'http_402'
            then interval '5 minutes' else interval '1 minute' end,
          updated_at = clock_timestamp()
      where budget_key = v_budget_key;
  end if;
  update public.instantly_qualification_ai_checkpoints
    set raw_response = p_raw_response, lease_token = null, lease_until = null,
        attempts = attempts - case when p_raw_response is null and p_error_code in ('http_402', 'http_429') then 1 else 0 end,
        last_error_code = case when p_raw_response is null then left(p_error_code, 80) else null end,
        updated_at = clock_timestamp()
    where checkpoint_key = p_checkpoint_key;
  return jsonb_build_object('state', case when p_raw_response is null then 'released' else 'saved' end);
end;
$$;

revoke all on table public.instantly_qualification_ai_budgets from public;
revoke all on table public.instantly_qualification_ai_checkpoints from public;
revoke all on function public.reserve_instantly_qualification_ai(text, text) from public;
revoke all on function public.finish_instantly_qualification_ai(text, uuid, text, text) from public;
do $$
declare v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'instantly'] loop
    if exists(select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on table public.instantly_qualification_ai_budgets from %I', v_role);
      execute format('revoke all on table public.instantly_qualification_ai_checkpoints from %I', v_role);
      execute format('revoke all on function public.reserve_instantly_qualification_ai(text, text) from %I', v_role);
      execute format('revoke all on function public.finish_instantly_qualification_ai(text, uuid, text, text) from %I', v_role);
      if v_role in ('service_role', 'instantly') then
        execute format('grant execute on function public.reserve_instantly_qualification_ai(text, text) to %I', v_role);
        execute format('grant execute on function public.finish_instantly_qualification_ai(text, uuid, text, text) to %I', v_role);
      end if;
    end if;
  end loop;
end;
$$;
