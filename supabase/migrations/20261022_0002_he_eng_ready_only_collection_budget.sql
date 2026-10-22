-- New manual ENG collections buy 500 ready contacts, not a paid reserve.
-- Admit reserve_target = 0 in the same exact empty initial checkpoint; retain
-- compatibility with historical 2000..5000 targets. A future-volume forecast
-- is not a collected-contact count and does not belong in this ledger guard.
-- No existing budget, collection, job, paid history or reservation is reset.

-- CREATE OR REPLACE preserves the function's existing owner and ACL, including
-- the restricted grants from 20261020_0004. Do not create it under new default
-- privileges if the prerequisite migration was skipped.
do $$
begin
  if to_regprocedure('public.he_eng_base_budget_begin(uuid,uuid)') is null then
    raise exception 'ENG ready-only collection budget: missing budget RPC, apply earlier ENG budget migrations first';
  end if;
end;
$$;

create or replace function public.he_eng_base_budget_begin(p_base_id uuid, p_project_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_base public.he_bases%rowtype;
  v_budget public.he_eng_base_budgets%rowtype;
  v_cutoff timestamptz;
  v_initial_keys text[] := array['limit','hypothesis_ids','refill','campaign_id','eng_base_budget_version'];
  v_reserve_target numeric;
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

    if jsonb_typeof(v_base.collect_info) is distinct from 'object' then
      return jsonb_build_object('code','missing_history');
    end if;
    if v_base.collect_info ?| array['eng_collection_target','eng_collection_work','eng_collection_pool'] then
      -- Compare complete JSON objects, not just known counters. Missing, extra,
      -- partial, nested, or progressed metadata cannot obtain a fresh ledger.
      -- Check the type before casting: arbitrary JSON must fail closed rather
      -- than throw an invalid numeric-input exception inside a combined WHERE.
      if jsonb_typeof(v_base.collect_info->'eng_collection_target'->'reserve_target')
          is distinct from 'number' then
        return jsonb_build_object('code','missing_history');
      end if;
      v_reserve_target := (v_base.collect_info->'eng_collection_target'->>'reserve_target')::numeric;
      if (v_reserve_target <> 0 and (v_reserve_target < 2000 or v_reserve_target > 5000))
        or v_reserve_target <> trunc(v_reserve_target)
        or coalesce(v_base.max_emails_per_company, 5) not between 1 and 100
        or v_base.collect_info->'eng_collection_target' is distinct from jsonb_build_object(
          'version',1,'ready_target',500,'reserve_target',v_reserve_target,
          'ready_count',0,'reserve_count',0,'total_ready',0,
          'phase','collecting','stop_reason',null,'rounds_completed',0)
        or v_base.collect_info->'eng_collection_work' is distinct from jsonb_build_object(
          'version',1,'round',1,'batch_size',100,'active_source_key',null,
          'seen_companies','[]'::jsonb,'history','[]'::jsonb)
        or v_base.collect_info->'eng_collection_pool' is distinct from jsonb_build_object(
          'version',1,'max_emails_per_company',coalesce(v_base.max_emails_per_company,5),
          'candidates_processed',0,'rows','[]'::jsonb,'rounds','[]'::jsonb) then
        return jsonb_build_object('code','missing_history');
      end if;
      v_initial_keys := v_initial_keys || array['eng_collection_target','eng_collection_work','eng_collection_pool'];
    end if;

    -- Initial route metadata is unpaid. Anything else is ambiguous old work,
    -- including old-worker calls in the migration/application rollout gap.
    if v_base.created_at < v_cutoff
      or v_base.collect_info->'eng_base_budget_version' is distinct from '1'::jsonb
      or v_base.analysis is not null
      or coalesce(v_base.collect_info - v_initial_keys, '{}'::jsonb) <> '{}'::jsonb
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
