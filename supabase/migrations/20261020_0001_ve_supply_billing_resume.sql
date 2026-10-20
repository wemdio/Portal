-- Explicit retry of a legacy Requesty failure resumes its paid source batch.
-- This is not automatic billing recovery and does not grant a new collection budget.
create or replace function public.ve_set_contact_supply_status(p_plan_id uuid,p_status text,p_actor_id uuid,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.ve_contact_supply_plans%rowtype;
  v_batch public.ve_contact_supply_batches%rowtype;
  v_base public.ve_bases%rowtype;
  v_job public.ve_jobs%rowtype;
  v_info jsonb;
  v_progress jsonb;
  v_error text;
  v_round integer;
  v_completed integer;
  v_max_rounds integer;
  v_max_candidates integer;
  v_processed integer;
begin
  if p_actor_id is null or p_now is null or p_status is null or p_status not in ('paused','active') then
    raise exception 'explicit pause/resume identity required';
  end if;
  select * into v_plan from public.ve_contact_supply_plans where id=p_plan_id for update;
  if not found then raise exception 'supply plan not found'; end if;
  if p_status='active' and not public.ve_contact_supply_approval_current(p_plan_id) then
    raise exception 'supply approval is stale; review targeting and existing campaigns';
  end if;
  if p_status='active' and exists(select 1 from public.ve_launch_queue_items qi where qi.id=v_plan.item_id
    and qi.status in ('released','skipped','cancelled')) then
    raise exception 'restore original launch bundle to active portfolio before resuming supply';
  end if;

  if p_status='active' then
    select * into v_batch from public.ve_contact_supply_batches
      where plan_id=p_plan_id order by created_at desc,id desc limit 1 for update;
    if found and v_batch.status='failed' and v_batch.audit_id is null then
      select * into v_base from public.ve_bases where id=v_batch.base_id for update;
      v_error:=concat_ws(' ',v_batch.error,v_base.error,v_base.collect_info->'target_progress'->>'reason');
      if v_error ~* 'Requesty[[:space:]]*(HTTP[[:space:]]*)?[:(]?[[:space:]]*402\M'
        or (v_error ~* '\mRequesty\M' and v_error ~* 'not enough credits|insufficient[ _-]+(funds|balance|credits)|payment[ _-]+required|credit balance (is )?too low') then
        -- Once a failed paid source is identified, invalid state must refuse
        -- the request, never fall through to starting a replacement batch.
        v_info:=v_base.collect_info;
        v_progress:=v_info->'target_progress';
        if v_plan.item_id is null or v_plan.status not in ('error','paused','active')
          or v_base.status is distinct from 'failed' or v_base.source is distinct from 'auto'
          or v_base.project_id is distinct from v_plan.project_id
          or v_base.hypothesis_id is distinct from v_plan.hypothesis_id
          or v_info->>'collection_mode' is distinct from 'supply'
          or v_info->>'supply_batch_id' is distinct from v_batch.id::text
          or coalesce(v_info->'refill','false'::jsonb)<>'false'::jsonb
          or v_batch.appended_count<>0 or coalesce(v_batch.append_snapshot,'[]'::jsonb)<>'[]'::jsonb
          or v_batch.rules_snapshot is distinct from v_plan.approval_snapshot
          or jsonb_typeof(v_base.data) is distinct from 'array'
          or v_base.row_count<>jsonb_array_length(v_base.data) or p_now<v_base.updated_at
          or jsonb_typeof(v_progress) is distinct from 'object'
          or v_progress->>'mode' is distinct from 'supply'
          or v_progress->>'status' is distinct from 'error' then
          raise exception 'Saved billing-failed supply state changed; no replacement batch was started';
        end if;
        -- Reject malformed or unbounded legacy checkpoints before any write.
        if exists(select 1 from unnest(array['round','max_rounds','max_candidates','candidates_processed','ready_target','ready_rows']) key
            where jsonb_typeof(v_progress->key) is distinct from 'number')
          or jsonb_typeof(v_info->'ready_target') is distinct from 'number'
          or (v_info->'target_checkpoint'->'completed_round' is not null
            and jsonb_typeof(v_info->'target_checkpoint'->'completed_round') is distinct from 'number')
          or coalesce(v_progress->>'round','') !~ '^[0-9]{1,5}$'
          or coalesce(v_progress->>'max_rounds','') !~ '^[0-9]{1,5}$'
          or coalesce(v_progress->>'max_candidates','') !~ '^[0-9]{1,5}$'
          or coalesce(v_progress->>'candidates_processed','') !~ '^[0-9]{1,5}$'
          or coalesce(v_progress->>'ready_target','') !~ '^[0-9]{1,5}$'
          or coalesce(v_progress->>'ready_rows','') !~ '^[0-9]{1,8}$'
          or coalesce(v_info->'target_checkpoint'->>'completed_round','0') !~ '^[0-9]{1,5}$'
          or (v_progress ? 'first_round_candidates' and (
            jsonb_typeof(v_progress->'first_round_candidates') is distinct from 'number'
            or coalesce(v_progress->>'first_round_candidates','') !~ '^[0-9]{1,4}$'
            or (v_progress->>'first_round_candidates')::integer not between 1 and 2000))
          or v_info->>'ready_target' is distinct from v_progress->>'ready_target'
          or (v_progress->>'ready_target')::integer<>v_batch.requested_count then
          raise exception 'Saved billing-failed supply checkpoint is invalid; no replacement batch was started';
        end if;
        v_round:=(v_progress->>'round')::integer;
        v_completed:=coalesce(v_info->'target_checkpoint'->>'completed_round','0')::integer;
        v_max_rounds:=(v_progress->>'max_rounds')::integer;
        v_max_candidates:=(v_progress->>'max_candidates')::integer;
        v_processed:=(v_progress->>'candidates_processed')::integer;
        if v_max_rounds not between 1 and 10000 or v_max_candidates not between 1 and 10000
          or v_round not between 1 and v_max_rounds or v_processed not between 0 and v_max_candidates
          or v_completed not in (v_round-1,v_round)
          or (v_completed=v_round-1 and (
            coalesce(v_info->'validation_retry','false'::jsonb)<>'false'::jsonb
            or coalesce(v_info->'relevance_review_requested','false'::jsonb)<>'false'::jsonb
            or coalesce(v_info->'company_name_recovery','null'::jsonb)<>'null'::jsonb))
          or v_batch.requested_count>v_max_candidates
          or (v_completed=v_round and jsonb_typeof(v_info->'target_checkpoint') is distinct from 'object')
          or (v_completed=v_round and not (coalesce(
            v_info->'relevance_reserve'->>'version'='1'
              and jsonb_typeof(v_info->'relevance_reserve'->'rows')='array',false)
            or coalesce(jsonb_typeof(v_info->'company_name_recovery')='object',false))) then
          raise exception 'Saved billing-failed supply checkpoint cannot be continued safely';
        end if;
        select * into v_job from public.ve_jobs where project_id=v_plan.project_id
          and stage='base_collect' and payload->>'base_id'=v_base.id::text
          order by created_at desc,id desc limit 1 for update nowait;
        if not found or v_job.status not in ('done','failed')
          or v_job.payload->>'supply_batch_id' is distinct from v_batch.id::text
          or v_job.payload->>'collection_mode' is distinct from 'supply'
          or v_job.payload->>'hypothesis_id' is distinct from v_base.hypothesis_id::text
          or v_job.payload->>'vertical_id' is distinct from v_base.vertical_id::text
          or coalesce(v_job.payload->'refill','false'::jsonb)<>'false'::jsonb
          or coalesce(v_job.payload->'review_relevance','false'::jsonb)<>'false'::jsonb
          or exists(select 1 from public.ve_jobs j where j.project_id=v_plan.project_id
            and j.stage='base_collect' and j.payload->>'base_id'=v_base.id::text
            and j.status in ('pending','running')) then
          raise exception 'Previous supply attempt is active, cancelled or changed; wait or review its saved state';
        end if;
        if exists(select 1 from public.ve_contact_supply_batches b where b.plan_id=p_plan_id
          and b.id<>v_batch.id and b.status in ('collecting','auditing','ready')) then
          raise exception 'Another supply batch is already active';
        end if;
        v_info:=v_info||jsonb_build_object('supply_billing_resume',jsonb_build_object(
          'version',1,'batch_id',v_batch.id,'job_id',v_job.id,
          'blocked_at',v_base.updated_at,'resumed_at',p_now,
          'max_rounds',v_max_rounds,'max_candidates',v_max_candidates));
        if v_completed=v_round then
          v_info:=v_info||jsonb_build_object('relevance_review_requested',true);
          if jsonb_typeof(v_info->'company_name_recovery')='object' then
            v_info:=jsonb_set(v_info,'{company_name_recovery,retry_validation_after_cleanup}','true'::jsonb);
          end if;
        end if;
        v_info:=jsonb_set(v_info,'{target_progress}',(v_progress-'reason')||'{"status":"collecting"}'::jsonb);
        update public.ve_bases set status='collecting',error=null,collect_info=v_info,updated_at=p_now where id=v_base.id;
        update public.ve_contact_supply_batches set status='collecting',error=null,updated_at=p_now where id=v_batch.id;
        -- Preserve paid checkpoints in result, the original payload and usage.
        -- Old automatic billing observations do not authorize this explicit retry.
        update public.ve_jobs set status='pending',error=null,started_at=null,finished_at=null,run_after=p_now,updated_at=p_now,
          payload=payload-'requesty_billing_wait'-'requesty_billing_recovery'
          where id=v_job.id;
      end if;
    end if;
  end if;
  -- Existing audited-source retry is unchanged.
  if p_status='active' and v_plan.status='error' then
    update public.ve_contact_supply_batches b set status='collecting',audit_id=null,
      append_snapshot=null,error=null,updated_at=p_now
    where b.id=(select latest.id from public.ve_contact_supply_batches latest
      where latest.plan_id=p_plan_id order by latest.created_at desc,latest.id desc limit 1)
      and b.status='failed' and b.audit_id is not null
      and exists(select 1 from public.ve_bases source where source.id=b.base_id and source.status='analyzed');
  end if;
  update public.ve_contact_supply_plans set status=case when p_status='active' and item_id is null then 'approved' else p_status end,
    last_error=null,updated_at=p_now where id=p_plan_id returning * into v_plan;
  return to_jsonb(v_plan);
end;
$$;

revoke all on function public.ve_set_contact_supply_status(uuid,text,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.ve_set_contact_supply_status(uuid,text,uuid,timestamptz) to service_role;

-- A runner can have observed the old failure immediately before the explicit
-- retry took the plan lock. Do not let that stale terminal decision close the
-- restored batch, including after a fast successful saved-review completion.
create or replace function public.ve_finish_contact_supply_batch(p_batch_id uuid,p_status text,p_error text,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_batch public.ve_contact_supply_batches%rowtype; v_plan public.ve_contact_supply_plans%rowtype;
  v_progress jsonb; v_estimate jsonb; v_base public.ve_bases%rowtype; v_resume jsonb;
begin
  if p_status not in ('active','exhausted','limited','error') or p_now is null then raise exception 'invalid supply outcome'; end if;
  select * into v_batch from public.ve_contact_supply_batches where id=p_batch_id;
  select * into v_plan from public.ve_contact_supply_plans where id=v_batch.plan_id for update;
  select * into v_batch from public.ve_contact_supply_batches where id=p_batch_id for update;
  if v_batch.id is null then raise exception 'supply batch not found'; end if;
  select * into v_base from public.ve_bases where id=v_batch.base_id for update;
  v_progress:=v_base.collect_info->'target_progress';
  v_estimate:=v_base.collect_info->'estimate';
  v_resume:=v_base.collect_info->'supply_billing_resume';
  if v_resume->>'version'='1' and v_resume->>'batch_id'=v_batch.id::text
    and v_base.project_id=v_plan.project_id and v_base.hypothesis_id=v_plan.hypothesis_id
    and v_resume->>'resumed_at' is not null
    and (v_base.status='collecting' or p_now<(v_resume->>'resumed_at')::timestamptz) then
    return to_jsonb(v_plan);
  end if;
  if v_batch.status<>'appended' and p_status not in ('error','limited')
    and coalesce((v_progress->>'ready_rows')::integer,-1)<>0 then raise exception 'ready supply must be audited/appended before finish'; end if;
  update public.ve_contact_supply_batches set status=case when status='appended' then status
      when p_status='error' or (p_status='limited' and coalesce((v_progress->>'ready_rows')::integer,0)>0) then 'failed' else 'appended' end,
    append_snapshot=coalesce(append_snapshot,'[]'::jsonb),error=p_error,updated_at=p_now where id=p_batch_id;
  update public.ve_contact_supply_plans set status=case when status='paused'
      or not public.ve_contact_supply_approval_current(v_plan.id) then 'paused' else p_status end,
    source_state=jsonb_build_object('previous_base_id',v_batch.base_id,'target_progress',v_progress),
    estimate=case when jsonb_typeof(v_estimate)='object' then v_estimate else estimate end,
    last_error=p_error,updated_at=p_now where id=v_plan.id returning * into v_plan;
  return to_jsonb(v_plan);
end;
$$;
revoke all on function public.ve_finish_contact_supply_batch(uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.ve_finish_contact_supply_batch(uuid,text,text,timestamptz) to service_role;
