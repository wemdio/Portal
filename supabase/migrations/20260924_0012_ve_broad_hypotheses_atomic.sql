-- One transaction for append-only broad hypotheses and the job receipt.
-- A retry after an unknown commit outcome returns the original IDs.
create or replace function public.ve_broad_title_key(p_title text)
returns text language sql immutable strict set search_path = '' as $$
  select btrim(regexp_replace(replace(lower(p_title), 'ё', 'е'), '[^[:alnum:]]+', ' ', 'g'));
$$;

create or replace function public.ve_commit_broad_hypotheses(
  p_job_id uuid, p_project_id uuid, p_candidates jsonb,
  p_duplicates jsonb, p_requested integer, p_tokens_used bigint, p_cost_usd numeric
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.ve_jobs%rowtype;
  v_project_status text;
  v_slots integer;
  v_rank integer;
  v_candidate jsonb;
  v_title text;
  v_key text;
  v_pct integer;
  v_vertical_id uuid;
  v_hypothesis_id uuid;
  v_added jsonb := '[]'::jsonb;
  v_duplicates jsonb := p_duplicates;
  v_result jsonb;
begin
  select * into v_job from public.ve_jobs where id = p_job_id for update;
  if not found or v_job.project_id <> p_project_id or v_job.stage <> 'broad_hypotheses' then
    raise exception 'Broad hypothesis job does not belong to this project';
  end if;
  if v_job.result->>'broad_hypotheses_committed' = 'true' then
    return v_job.result;
  end if;
  if v_job.status <> 'running' then
    raise exception 'Broad hypothesis job is not running';
  end if;

  -- Serialize appends for this project and protect the research-state check.
  select status into v_project_status from public.ve_projects where id = p_project_id for update;
  if not found or v_project_status = 'researching' then
    raise exception 'Project is missing or research is running';
  end if;
  if not exists (select 1 from public.ve_verticals where project_id = p_project_id) then
    raise exception 'Project has no researched verticals';
  end if;
  if jsonb_typeof(p_candidates) is distinct from 'array'
    or jsonb_typeof(p_duplicates) is distinct from 'array'
    or p_requested is null or p_requested not between 0 and 5
    or p_tokens_used is null or p_tokens_used < 0
    or p_cost_usd is null or p_cost_usd < 0 then
    raise exception 'Invalid broad hypothesis commit arguments';
  end if;
  if jsonb_array_length(p_candidates) > p_requested then
    raise exception 'More candidates than requested';
  end if;

  select greatest(0, 5 - count(*)) into v_slots from public.ve_hypotheses
    where project_id = p_project_id and broad = true and status <> 'rejected';
  select greatest(coalesce(max(rank), 0), count(*)) into v_rank
    from public.ve_verticals where project_id = p_project_id;

  for v_candidate in select value from jsonb_array_elements(p_candidates) loop
    exit when v_slots = 0;
    v_title := btrim(v_candidate->>'title');
    v_key := public.ve_broad_title_key(v_title);
    v_pct := (v_candidate->>'potential_pct')::integer;
    if coalesce(v_key, '') = ''
      or coalesce(btrim(v_candidate->>'description'), '') = ''
      or coalesce(btrim(v_candidate->>'fit_rationale'), '') = ''
      or v_pct is null or v_pct not between 0 and 100 then
      raise exception 'Invalid broad hypothesis candidate';
    end if;
    -- Recheck against the current DB snapshot, including vertical aliases.
    if exists (
      select 1 from public.ve_hypotheses h where h.project_id = p_project_id
        and public.ve_broad_title_key(h.title) = v_key
      union all
      select 1 from public.ve_verticals v where v.project_id = p_project_id
        and (public.ve_broad_title_key(v.name) = v_key or exists (
          select 1 from jsonb_array_elements_text(
            case when jsonb_typeof(v.synonyms) = 'array' then v.synonyms else '[]'::jsonb end
          ) s where public.ve_broad_title_key(s.value) = v_key
        ))
    ) then
      v_duplicates := v_duplicates || jsonb_build_array(v_title);
      continue;
    end if;
    v_rank := v_rank + 1;
    insert into public.ve_verticals(project_id, name, summary, synonyms, potential_pct, rank)
      values (p_project_id, v_title, v_candidate->>'description', jsonb_build_array(v_title), least(95, v_pct), v_rank)
      returning id into v_vertical_id;
    insert into public.ve_hypotheses(
      project_id, vertical_id, tier, title, description, fit_rationale,
      evidence, seasonality, potential_pct, status, broad
    ) values (
      p_project_id, v_vertical_id, 1, v_title, v_candidate->>'description', v_candidate->>'fit_rationale',
      '[]'::jsonb, null, v_pct, 'proposed', true
    ) returning id into v_hypothesis_id;
    v_added := v_added || jsonb_build_array(jsonb_build_object(
      'title', v_title, 'hypothesis_id', v_hypothesis_id, 'vertical_id', v_vertical_id
    ));
    v_slots := v_slots - 1;
  end loop;

  v_result := jsonb_build_object(
    'broad_hypotheses_committed', true, 'added', v_added, 'duplicates', v_duplicates,
    'requested', p_requested, 'tokensUsed', p_tokens_used, 'costUsd', p_cost_usd
  );
  update public.ve_jobs set result = v_result, updated_at = now() where id = p_job_id;
  return v_result;
end;
$$;

revoke all on function public.ve_broad_title_key(text) from public, anon, authenticated;
revoke all on function public.ve_commit_broad_hypotheses(uuid, uuid, jsonb, jsonb, integer, bigint, numeric) from public, anon, authenticated;
grant execute on function public.ve_broad_title_key(text) to service_role;
grant execute on function public.ve_commit_broad_hypotheses(uuid, uuid, jsonb, jsonb, integer, bigint, numeric) to service_role;
