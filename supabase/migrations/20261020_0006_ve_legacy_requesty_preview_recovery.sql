-- Historical preview parents could finish "done" after recording a failed
-- base. Adopt only the current preparation and its completed paid children.
-- No replacement job/base, source reset, attempt reset or extra budget.
create function public.ve_resume_legacy_requesty_preview(
  p_project_id uuid,p_hypothesis_id uuid,p_base_id uuid,p_expected_updated_at timestamptz,
  p_key_fingerprint text,p_credit_signal jsonb,p_credit_observed_at timestamptz,p_now timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_preparation public.ve_outreach_preparations%rowtype;
  v_setup public.ve_outreach_setups%rowtype;
  v_base public.ve_bases%rowtype;
  v_job public.ve_jobs%rowtype;
  v_info jsonb;
  v_progress jsonb;
  v_pipeline jsonb;
  v_previous jsonb;
  v_credit jsonb;
  v_round integer;
  v_completed integer;
  v_max_rounds integer;
  v_max_candidates integer;
  v_processed integer;
begin
  if p_project_id is null or p_hypothesis_id is null or p_base_id is null
    or p_expected_updated_at is null or p_now is null
    or p_key_fingerprint is null or p_key_fingerprint !~ '^[a-f0-9]{64}$'
    or p_credit_observed_at is null or p_credit_observed_at>p_now
    or p_credit_observed_at<p_now-interval '2 minutes'
    or jsonb_typeof(p_credit_signal) is distinct from 'object' then
    return jsonb_build_object('resumed',false,'reason','invalid_credit_observation');
  end if;
  if exists(select 1 from unnest(array['balanceUsd','monthlySpendUsd','monthlyLimitUsd']) key
    where jsonb_typeof(p_credit_signal->key) is distinct from 'number') then
    return jsonb_build_object('resumed',false,'reason','invalid_credit_observation');
  end if;
  if exists(select 1 from unnest(array['balanceUsd','monthlySpendUsd','monthlyLimitUsd']) key
    where (p_credit_signal->>key)::numeric<0 or (p_credit_signal->>key)::numeric>1e18) then
    return jsonb_build_object('resumed',false,'reason','invalid_credit_observation');
  end if;
  if (p_credit_signal->>'balanceUsd')::numeric<=0
    or ((p_credit_signal->>'monthlyLimitUsd')::numeric>0
      and (p_credit_signal->>'monthlySpendUsd')::numeric>=(p_credit_signal->>'monthlyLimitUsd')::numeric) then
    return jsonb_build_object('resumed',false,'reason','credit_unavailable');
  end if;
  -- Selection, pause/cancel, preparation claims and launch share this lock.
  if not pg_try_advisory_xact_lock(hashtextextended(p_project_id::text,22082029)) then
    return jsonb_build_object('resumed',false,'reason','busy');
  end if;
  select * into v_preparation from public.ve_outreach_preparations
    where project_id=p_project_id and hypothesis_id=p_hypothesis_id for update nowait;
  if not found or v_preparation.status<>'error' or v_preparation.base_id is distinct from p_base_id
    or v_preparation.updated_at is distinct from p_expected_updated_at
    or v_preparation.paused_at is not null or v_preparation.cancelled_at is not null
    or v_preparation.template_id is not null
    or v_preparation.locked_until>p_now then
    return jsonb_build_object('resumed',false,'reason','preparation_changed');
  end if;
  select * into v_setup from public.ve_outreach_setups where project_id=p_project_id for share nowait;
  if not found or (not v_preparation.independent_control and
    (not (p_hypothesis_id=any(v_setup.selected_hypothesis_ids)) or v_preparation.language<>v_setup.language))
    or (v_setup.approved_bases ? p_base_id::text)
    or not exists(select 1 from public.ve_hypotheses h join public.ve_projects p on p.id=h.project_id
      where h.id=p_hypothesis_id and h.project_id=p_project_id and h.status<>'rejected' and h.vertical_id is not null) then
    return jsonb_build_object('resumed',false,'reason','preparation_not_authorized');
  end if;
  if public.ve_base_audience_frozen(p_base_id)
    or exists(select 1 from public.ve_outreach_runs r where r.project_id=p_project_id
      and r.status in ('queued','running','waiting')
      and exists(select 1 from jsonb_array_elements(r.request->'items') item
        where item->>'hypothesis_id'=p_hypothesis_id::text)) then
    return jsonb_build_object('resumed',false,'reason','already_launched');
  end if;
  -- Match the worker write-fence lock order: job before base.
  select * into v_job from public.ve_jobs where project_id=p_project_id
    and payload->>'base_id'=p_base_id::text
    order by created_at desc,id desc limit 1 for update nowait;
  if not found or v_job.stage<>'base_collect' or v_job.status not in ('done','failed')
    or v_job.payload->>'collection_mode' is distinct from 'preview'
    or v_job.payload->>'hypothesis_id' is distinct from p_hypothesis_id::text
    or coalesce(v_job.payload->'refill','false'::jsonb)<>'false'::jsonb
    or coalesce(v_job.payload->'review_relevance','false'::jsonb)<>'false'::jsonb
    or coalesce(v_job.payload->'requesty_billing_wait','null'::jsonb)<>'null'::jsonb
    or exists(select 1 from public.ve_jobs j join public.ve_bases b on b.id::text=j.payload->>'base_id'
      where j.project_id=p_project_id and b.hypothesis_id=p_hypothesis_id and j.status in ('pending','running')) then
    return jsonb_build_object('resumed',false,'reason','job_changed');
  end if;
  select * into v_base from public.ve_bases where id=p_base_id for update nowait;
  if not found or v_base.project_id<>p_project_id or v_base.hypothesis_id is distinct from p_hypothesis_id
    or v_base.source<>'auto' or v_base.status<>'failed' or v_base.updated_at>p_now
    or v_job.payload->>'vertical_id' is distinct from v_base.vertical_id::text
    or not exists(select 1 from public.ve_hypotheses h where h.id=p_hypothesis_id and h.vertical_id=v_base.vertical_id)
    or exists(select 1 from public.ve_bases b where b.project_id=p_project_id and b.hypothesis_id=p_hypothesis_id
      and b.id<>p_base_id and (b.created_at,b.id)>(v_base.created_at,v_base.id)) then
    return jsonb_build_object('resumed',false,'reason','base_changed');
  end if;
  v_info:=v_base.collect_info;
  v_progress:=v_info->'target_progress';
  if v_info->>'collection_mode' is distinct from 'preview'
    or coalesce(v_info->'refill','false'::jsonb)<>'false'::jsonb
    or jsonb_typeof(v_base.data) is distinct from 'array' then
    return jsonb_build_object('resumed',false,'reason','invalid_checkpoint');
  end if;
  if v_base.row_count<>jsonb_array_length(v_base.data)
    or v_progress->>'mode' is distinct from 'preview' or v_progress->>'status' is distinct from 'error' then
    return jsonb_build_object('resumed',false,'reason','invalid_checkpoint');
  end if;
  if exists(select 1 from unnest(array[v_preparation.last_error,v_base.error,v_progress->>'reason']) error_text
      where error_text is null or error_text !~* '^[[:space:]]*Requesty[[:space:]]*(HTTP[[:space:]]*)?[:(]?[[:space:]]*402\M')
    or concat_ws(' ',v_preparation.last_error,v_base.error,v_progress->>'reason') ~* '\m(Serper|OpenRouter|Polza)\M'
    or (nullif(btrim(v_job.error),'') is not null and (v_job.error !~* '^[[:space:]]*Requesty[[:space:]]*(HTTP[[:space:]]*)?[:(]?[[:space:]]*402\M'
      or v_job.error ~* '\m(Serper|OpenRouter|Polza)\M')) then
    return jsonb_build_object('resumed',false,'reason','not_requesty_billing');
  end if;
  if exists(select 1 from unnest(array['round','max_rounds','max_candidates','candidates_processed','ready_target','ready_rows']) key
      where jsonb_typeof(v_progress->key) is distinct from 'number' or coalesce(v_progress->>key,'') !~ '^[0-9]{1,8}$')
    or jsonb_typeof(v_info->'ready_target') is distinct from 'number'
    or v_info->>'ready_target' is distinct from v_progress->>'ready_target'
    or jsonb_typeof(v_info->'target_checkpoint') is distinct from 'object'
    or jsonb_typeof(v_info->'target_checkpoint'->'completed_round') is distinct from 'number'
    or coalesce(v_info->'target_checkpoint'->>'completed_round','') !~ '^[0-9]{1,5}$'
    or jsonb_typeof(v_info->'target_checkpoint'->'seen_rows') is distinct from 'array'
    or (v_progress ? 'first_round_candidates' and (jsonb_typeof(v_progress->'first_round_candidates') is distinct from 'number'
      or coalesce(v_progress->>'first_round_candidates','') !~ '^[0-9]{1,4}$')) then
    return jsonb_build_object('resumed',false,'reason','invalid_checkpoint');
  end if;
  v_round:=(v_progress->>'round')::integer;
  v_completed:=(v_info->'target_checkpoint'->>'completed_round')::integer;
  v_max_rounds:=(v_progress->>'max_rounds')::integer;
  v_max_candidates:=(v_progress->>'max_candidates')::integer;
  v_processed:=(v_progress->>'candidates_processed')::integer;
  if v_max_rounds not between 1 and 10000 or v_max_candidates not between 1 and 10000
    or v_round not between 1 and v_max_rounds or v_processed not between 0 and v_max_candidates
    or (v_progress->>'ready_target')::integer not between 1 and v_max_candidates
    or (v_progress ? 'first_round_candidates' and (v_progress->>'first_round_candidates')::integer not between 1 and 2000)
    or v_completed not in (v_round-1,v_round)
    or (v_completed=v_round-1 and (coalesce(v_info->'validation_retry','false'::jsonb)<>'false'::jsonb
      or coalesce(v_info->'relevance_review_requested','false'::jsonb)<>'false'::jsonb
      or coalesce(v_info->'company_name_recovery','null'::jsonb)<>'null'::jsonb))
    or (v_completed=v_round and not (coalesce(v_info->'relevance_reserve'->>'version'='1'
      and jsonb_typeof(v_info->'relevance_reserve'->'rows')='array',false)
      or coalesce(jsonb_typeof(v_info->'company_name_recovery')='object',false))) then
    return jsonb_build_object('resumed',false,'reason','invalid_checkpoint');
  end if;
  -- Never infer a shared child's credentials from its error text or restart
  -- one. This adoption accepts only completed children and an empty pipeline.
  if jsonb_typeof(v_info->'tasks') is distinct from 'array' then
    return jsonb_build_object('resumed',false,'reason','child_state_unconfirmed');
  end if;
  if exists(select 1 from jsonb_array_elements(v_info->'tasks') task
      where jsonb_typeof(task) is distinct from 'object' or coalesce(task->>'status','') not in ('pending','done')
        or (task->>'status'='pending' and nullif(task->>'child_job_id','') is not null))
    or (v_info->'construct' is not null and (v_info->'construct'->>'status' is distinct from 'done'
      or not exists(select 1 from public.base_constructor_jobs c
        where c.id::text=v_info->'construct'->>'bc_job_id' and c.status='completed'))) then
    return jsonb_build_object('resumed',false,'reason','child_state_unconfirmed');
  end if;
  v_pipeline:=v_info->'preview_pipeline';
  if coalesce(v_pipeline,'null'::jsonb)<>'null'::jsonb then
    if jsonb_typeof(v_pipeline) is distinct from 'object' or v_pipeline->'version' is distinct from '1'::jsonb
      or jsonb_typeof(v_pipeline->'revision') is distinct from 'number'
      or coalesce(v_pipeline->>'revision','') !~ '^[0-9]{1,9}$'
      or v_pipeline->'batches' is distinct from '[]'::jsonb
      or coalesce(v_pipeline->'active_batch_id','null'::jsonb)<>'null'::jsonb
      or nullif(v_pipeline->>'error','') is not null
      or jsonb_typeof(v_pipeline->'job_ids') is distinct from 'array' then
      return jsonb_build_object('resumed',false,'reason','child_state_unconfirmed');
    end if;
    if exists(select 1 from jsonb_array_elements_text(v_pipeline->'job_ids') child_id
      where not exists(select 1 from public.base_constructor_jobs c where c.id::text=child_id and c.status='completed')) then
      return jsonb_build_object('resumed',false,'reason','child_state_unconfirmed');
    end if;
  end if;
  v_previous:=v_job.payload->'requesty_billing_recovery';
  if coalesce(v_previous,'null'::jsonb)<>'null'::jsonb then
    v_credit:=v_previous->'credit_signal';
    if v_previous->'version' is distinct from '1'::jsonb
      or v_previous->>'key_fingerprint' is distinct from p_key_fingerprint
      or jsonb_typeof(v_credit) is distinct from 'object'
      or exists(select 1 from unnest(array['balanceUsd','monthlySpendUsd','monthlyLimitUsd']) key
        where jsonb_typeof(v_credit->key) is distinct from 'number') then
      return jsonb_build_object('resumed',false,'reason','previous_credit_unconfirmed');
    end if;
    if exists(select 1 from unnest(array['balanceUsd','monthlySpendUsd','monthlyLimitUsd']) key
      where (v_credit->>key)::numeric<0 or (v_credit->>key)::numeric>1e18) then
      return jsonb_build_object('resumed',false,'reason','previous_credit_unconfirmed');
    end if;
    if not ((p_credit_signal->>'balanceUsd')::numeric>(v_credit->>'balanceUsd')::numeric+0.000001
      or ((v_credit->>'monthlyLimitUsd')::numeric>0
        and ((p_credit_signal->>'monthlyLimitUsd')::numeric=0
          or (p_credit_signal->>'monthlyLimitUsd')::numeric>(v_credit->>'monthlyLimitUsd')::numeric
          or (p_credit_signal->>'monthlySpendUsd')::numeric<(v_credit->>'monthlySpendUsd')::numeric-0.000001))) then
      return jsonb_build_object('resumed',false,'reason','awaiting_credit_change');
    end if;
  end if;
  v_info:=v_info||jsonb_build_object('preview_billing_resume',jsonb_build_object(
    'version',1,'job_id',v_job.id,'blocked_at',v_base.updated_at,'resumed_at',p_now,
    'max_rounds',v_max_rounds,'max_candidates',v_max_candidates));
  if v_completed=v_round then
    v_info:=v_info||jsonb_build_object('relevance_review_requested',true);
    if jsonb_typeof(v_info->'company_name_recovery')='object' then
      v_info:=jsonb_set(v_info,'{company_name_recovery,retry_validation_after_cleanup}','true'::jsonb);
    end if;
  end if;
  v_info:=jsonb_set(v_info,'{target_progress}',(v_progress-'reason')||'{"status":"collecting"}'::jsonb);
  update public.ve_jobs set status='pending',error=null,started_at=null,finished_at=null,run_after=p_now,updated_at=p_now,
    payload=payload||jsonb_build_object('requesty_billing_recovery',jsonb_build_object(
      'version',1,'source','legacy_preview','origin','automatic_requesty_credit',
      'key_fingerprint',p_key_fingerprint,'credit_signal',p_credit_signal,
      'credit_observed_at',p_credit_observed_at,'blocked_at',v_base.updated_at,'resumed_at',p_now)) where id=v_job.id;
  update public.ve_bases set status='collecting',error=null,collect_info=v_info,updated_at=p_now where id=p_base_id;
  -- Collecting, not pending: the preparation coordinator must not grant an
  -- explicit continuation or enqueue a new paid collection job.
  update public.ve_outreach_preparations set status='collecting',last_error=null,locked_until=null,
    claim_token=null,updated_at=p_now where project_id=p_project_id and hypothesis_id=p_hypothesis_id;
  return jsonb_build_object('resumed',true,'reason','credit_available');
exception when lock_not_available then
  return jsonb_build_object('resumed',false,'reason','busy');
end;
$$;
revoke all on function public.ve_resume_legacy_requesty_preview(uuid,uuid,uuid,timestamptz,text,jsonb,timestamptz,timestamptz)
  from public,anon,authenticated;
grant execute on function public.ve_resume_legacy_requesty_preview(uuid,uuid,uuid,timestamptz,text,jsonb,timestamptz,timestamptz)
  to service_role;
