-- ENG only: one $5 allowance per base, shared by collection, analysis and letters.
-- Integer micro-USD, reserve BEFORE each paid physical request, settle from its
-- receipt. Unknown outcomes keep the reserve and stop further paid work.
--
-- Roll forward only. Do not truncate/reset these tables or delete reservations
-- on a retry/deploy. Old application images do not enforce this ledger: deploy
-- the matching workers before starting a new collection. Pre-migration bases
-- and bases with unaccounted saved work fail closed; no historical allowance
-- is silently reset. Removing this migration would remove the spending guard.

create table if not exists public.he_eng_base_budget_policy (
  singleton boolean primary key default true check (singleton),
  deployed_at timestamptz not null default clock_timestamp(),
  limit_microusd bigint not null default 5000000 check (limit_microusd = 5000000)
);
insert into public.he_eng_base_budget_policy(singleton) values (true) on conflict do nothing;

create table if not exists public.he_eng_base_budgets (
  base_id uuid primary key references public.he_bases(id) on delete cascade,
  project_id uuid not null references public.he_projects(id) on delete cascade,
  limit_microusd bigint not null default 5000000 check (limit_microusd = 5000000),
  actual_microusd bigint not null default 0 check (actual_microusd between 0 and 9007199254740991),
  reserved_microusd bigint not null default 0 check (reserved_microusd between 0 and 9007199254740991),
  hold_reason text check (hold_reason in ('budget_exhausted','unknown_cost','invalid_ledger','missing_history','unavailable')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (actual_microusd::numeric + reserved_microusd::numeric <= 9007199254740991),
  check (actual_microusd + reserved_microusd <= limit_microusd or hold_reason is not distinct from 'invalid_ledger')
);

create table if not exists public.he_eng_base_spend_requests (
  request_id uuid primary key,
  base_id uuid not null references public.he_eng_base_budgets(base_id) on delete cascade,
  provider text not null check (provider ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  stage text not null check (stage ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  model text check (model is null or (length(model) between 1 and 200 and model !~ '[[:cntrl:]]')),
  reserved_microusd bigint not null check (reserved_microusd between 1 and 5000000),
  actual_microusd bigint check (actual_microusd between 0 and 9007199254740991),
  status text not null default 'reserved' check (status in ('reserved','settled','unknown')),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  check ((status = 'settled') = (actual_microusd is not null)),
  check ((status = 'reserved') = (settled_at is null))
);
create index if not exists he_eng_base_spend_requests_base_status
  on public.he_eng_base_spend_requests(base_id, status);

comment on table public.he_eng_base_spend_requests is
  'ENG per-base paid request reservations. No contacts, prompts, keys or provider response bodies.';

alter table public.he_eng_base_budget_policy enable row level security;
alter table public.he_eng_base_budgets enable row level security;
alter table public.he_eng_base_spend_requests enable row level security;
revoke all privileges on table public.he_eng_base_budget_policy from public, anon, authenticated, service_role;
revoke all privileges on table public.he_eng_base_budgets from public, anon, authenticated, service_role;
revoke all privileges on table public.he_eng_base_spend_requests from public, anon, authenticated, service_role;
-- Only definer RPCs may mutate the ledger. Operational service reads are safe.
grant select on table public.he_eng_base_budget_policy to service_role;
grant select on table public.he_eng_base_budgets to service_role;
grant select on table public.he_eng_base_spend_requests to service_role;
grant all on table public.he_eng_base_budget_policy to postgres;
grant all on table public.he_eng_base_budgets to postgres;
grant all on table public.he_eng_base_spend_requests to postgres;

create or replace function public.he_eng_base_budget_state(p_base_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'baseId', b.base_id, 'projectId', b.project_id,
    'limitMicrousd', b.limit_microusd, 'actualMicrousd', b.actual_microusd,
    'reservedMicrousd', b.reserved_microusd,
    'remainingMicrousd', greatest(0, b.limit_microusd - b.actual_microusd - b.reserved_microusd),
    'holdReason', b.hold_reason)
  from public.he_eng_base_budgets b where b.base_id = p_base_id;
$$;
revoke all on function public.he_eng_base_budget_state(uuid) from public, anon, authenticated, service_role;
grant execute on function public.he_eng_base_budget_state(uuid) to postgres;

create or replace function public.he_eng_base_budget_begin(p_base_id uuid, p_project_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_base public.he_bases%rowtype;
  v_budget public.he_eng_base_budgets%rowtype;
  v_cutoff timestamptz;
begin
  -- The same owner rule as readHeProjectOwner; market alone is not ENG identity.
  select b.* into v_base from public.he_bases b
    join public.he_projects p on p.id = b.project_id
    join public.profiles owner on owner.id = p.created_by
    where b.id = p_base_id and b.project_id = p_project_id
      and p.market = 'us' and owner.role = 'client' and owner.market = 'eng'
    for update of b;
  if not found then return jsonb_build_object('code','invalid_ledger'); end if;

  select * into v_budget from public.he_eng_base_budgets where base_id = p_base_id for update;
  if not found then
    select deployed_at into v_cutoff from public.he_eng_base_budget_policy where singleton;
    if v_cutoff is null then return jsonb_build_object('code','unavailable'); end if;
    -- Initial route metadata is unpaid. Anything else is ambiguous old work,
    -- including old-worker calls in the migration/application rollout gap.
    if v_base.created_at < v_cutoff
      or v_base.collect_info->'eng_base_budget_version' is distinct from '1'::jsonb
      or v_base.analysis is not null
      or coalesce(v_base.collect_info - array['limit','hypothesis_ids','refill','campaign_id','eng_base_budget_version'], '{}'::jsonb) <> '{}'::jsonb
      or exists (select 1 from public.he_jobs j where j.project_id = p_project_id
        and j.payload->>'base_id' = p_base_id::text
        and (j.cost_usd <> 0 or j.tokens_used <> 0 or j.attempts > 0 or j.status in ('done','failed')))
      or exists (select 1 from public.he_templates t where t.base_id = p_base_id) then
      return jsonb_build_object('code','missing_history');
    end if;
    insert into public.he_eng_base_budgets(base_id, project_id) values (p_base_id, p_project_id);
    select * into v_budget from public.he_eng_base_budgets where base_id = p_base_id for update;
  end if;
  if v_budget.project_id <> p_project_id then return jsonb_build_object('code','invalid_ledger'); end if;
  if v_budget.hold_reason is not null then
    return jsonb_build_object('code',v_budget.hold_reason,'budget',public.he_eng_base_budget_state(p_base_id));
  end if;
  if exists (select 1 from public.he_eng_base_spend_requests
      where base_id = p_base_id and status <> 'settled') then
    return jsonb_build_object('code','pending_spend','budget',public.he_eng_base_budget_state(p_base_id));
  end if;
  return jsonb_build_object('code','ready','budget',public.he_eng_base_budget_state(p_base_id));
end;
$$;
revoke all on function public.he_eng_base_budget_begin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.he_eng_base_budget_begin(uuid, uuid) to service_role, postgres;

create or replace function public.he_eng_base_budget_reserve(
  p_base_id uuid, p_project_id uuid, p_request_id uuid,
  p_provider text, p_stage text, p_model text, p_reserved_microusd bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_budget public.he_eng_base_budgets%rowtype;
  v_request public.he_eng_base_spend_requests%rowtype;
begin
  if p_request_id is null or p_reserved_microusd is null or p_reserved_microusd < 1
    or p_provider is null or p_provider !~ '^[a-z][a-z0-9_.-]{0,63}$'
    or p_stage is null or p_stage !~ '^[a-z][a-z0-9_.-]{0,63}$'
    or (p_model is not null and (length(p_model) not between 1 and 200 or p_model ~ '[[:cntrl:]]')) then
    return jsonb_build_object('code','invalid_ledger');
  end if;
  select b.* into v_budget from public.he_eng_base_budgets b
    join public.he_bases hb on hb.id = b.base_id and hb.project_id = b.project_id
    join public.he_projects p on p.id = b.project_id
    join public.profiles owner on owner.id = p.created_by
    where b.base_id = p_base_id and b.project_id = p_project_id
      and p.market = 'us' and owner.role = 'client' and owner.market = 'eng'
    for update of b;
  if not found then return jsonb_build_object('code','invalid_ledger'); end if;

  select * into v_request from public.he_eng_base_spend_requests where request_id = p_request_id;
  if found then
    if v_request.base_id <> p_base_id or v_request.provider <> p_provider or v_request.stage <> p_stage
      or v_request.model is distinct from p_model or v_request.reserved_microusd <> p_reserved_microusd then
      return jsonb_build_object('code','invalid_ledger');
    end if;
    -- Idempotent accounting, but NEVER authorize repeating the paid HTTP call.
    return jsonb_build_object('code','request_reused','budget',public.he_eng_base_budget_state(p_base_id));
  end if;
  if v_budget.hold_reason is not null then
    return jsonb_build_object('code',v_budget.hold_reason,'budget',public.he_eng_base_budget_state(p_base_id));
  end if;
  if p_reserved_microusd > v_budget.limit_microusd - v_budget.actual_microusd - v_budget.reserved_microusd then
    update public.he_eng_base_budgets set hold_reason = 'budget_exhausted', updated_at = clock_timestamp()
      where base_id = p_base_id;
    return jsonb_build_object('code','budget_exhausted','budget',public.he_eng_base_budget_state(p_base_id));
  end if;
  insert into public.he_eng_base_spend_requests(request_id,base_id,provider,stage,model,reserved_microusd)
    values (p_request_id,p_base_id,p_provider,p_stage,p_model,p_reserved_microusd);
  update public.he_eng_base_budgets
    set reserved_microusd = reserved_microusd + p_reserved_microusd, updated_at = clock_timestamp()
    where base_id = p_base_id;
  return jsonb_build_object('code','reserved','budget',public.he_eng_base_budget_state(p_base_id));
end;
$$;
revoke all on function public.he_eng_base_budget_reserve(uuid, uuid, uuid, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.he_eng_base_budget_reserve(uuid, uuid, uuid, text, text, text, bigint) to service_role, postgres;

create or replace function public.he_eng_base_budget_settle(
  p_base_id uuid, p_project_id uuid, p_request_id uuid,
  p_reserved_microusd bigint, p_actual_microusd bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_budget public.he_eng_base_budgets%rowtype;
  v_request public.he_eng_base_spend_requests%rowtype;
begin
  if p_actual_microusd is not null and (p_actual_microusd < 0 or p_actual_microusd > 9007199254740991) then
    return jsonb_build_object('code','invalid_ledger');
  end if;
  select b.* into v_budget from public.he_eng_base_budgets b
    join public.he_bases hb on hb.id = b.base_id and hb.project_id = b.project_id
    join public.he_projects p on p.id = b.project_id
    join public.profiles owner on owner.id = p.created_by
    where b.base_id = p_base_id and b.project_id = p_project_id
      and p.market = 'us' and owner.role = 'client' and owner.market = 'eng'
    for update of b;
  if not found then return jsonb_build_object('code','invalid_ledger'); end if;
  select * into v_request from public.he_eng_base_spend_requests
    where request_id = p_request_id and base_id = p_base_id for update;
  if not found or p_reserved_microusd is null or v_request.reserved_microusd <> p_reserved_microusd then
    return jsonb_build_object('code','invalid_ledger');
  end if;
  if v_request.status <> 'reserved' then
    if v_request.actual_microusd is distinct from p_actual_microusd then
      return jsonb_build_object('code','invalid_ledger');
    end if;
    return jsonb_build_object('code','settled','budget',public.he_eng_base_budget_state(p_base_id));
  end if;
  if p_actual_microusd is null then
    update public.he_eng_base_spend_requests set status = 'unknown', settled_at = clock_timestamp()
      where request_id = p_request_id;
    update public.he_eng_base_budgets set hold_reason = coalesce(hold_reason, 'unknown_cost'), updated_at = clock_timestamp()
      where base_id = p_base_id;
  else
    if v_budget.actual_microusd::numeric + p_actual_microusd::numeric
        + v_budget.reserved_microusd::numeric - v_request.reserved_microusd::numeric > 9007199254740991 then
      update public.he_eng_base_budgets set hold_reason = 'invalid_ledger', updated_at = clock_timestamp()
        where base_id = p_base_id;
      return jsonb_build_object('code','invalid_ledger','budget',public.he_eng_base_budget_state(p_base_id));
    end if;
    update public.he_eng_base_spend_requests
      set status = 'settled', actual_microusd = p_actual_microusd, settled_at = clock_timestamp()
      where request_id = p_request_id;
    update public.he_eng_base_budgets
      set actual_microusd = actual_microusd + p_actual_microusd,
          reserved_microusd = reserved_microusd - v_request.reserved_microusd,
          hold_reason = case when p_actual_microusd > v_request.reserved_microusd then 'invalid_ledger' else hold_reason end,
          updated_at = clock_timestamp()
      where base_id = p_base_id;
  end if;
  return jsonb_build_object('code','settled','budget',public.he_eng_base_budget_state(p_base_id));
end;
$$;
revoke all on function public.he_eng_base_budget_settle(uuid, uuid, uuid, bigint, bigint) from public, anon, authenticated;
grant execute on function public.he_eng_base_budget_settle(uuid, uuid, uuid, bigint, bigint) to service_role, postgres;
