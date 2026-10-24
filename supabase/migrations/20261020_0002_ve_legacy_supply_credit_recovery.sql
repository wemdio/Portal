-- Adopt only a legacy VE2 supply failure after a verified, usable Requesty
-- balance observation. The service caller probes the CURRENT inference key;
-- this function never probes a provider or changes specialist approvals.
create function public.ve_resume_legacy_requesty_supply(
  p_plan_id uuid,p_expected_updated_at timestamptz,p_key_fingerprint text,
  p_credit_signal jsonb,p_credit_observed_at timestamptz,p_now timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_project_id uuid;
  v_plan public.ve_contact_supply_plans%rowtype;
  v_batch public.ve_contact_supply_batches%rowtype;
  v_base public.ve_bases%rowtype;
  v_job public.ve_jobs%rowtype;
  v_previous jsonb;
  v_credit jsonb;
  v_updated integer;
begin
  if p_plan_id is null or p_expected_updated_at is null or p_now is null
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
  select project_id into v_project_id from public.ve_contact_supply_plans where id=p_plan_id;
  if not found then return jsonb_build_object('resumed',false,'reason','plan_unavailable'); end if;
  -- Same project-first lock as specialist preparation Pause/Cancel. NOWAIT
  -- keeps the bounded sweep from waiting behind interactive operations.
  if not pg_try_advisory_xact_lock(hashtextextended(v_project_id::text,22082029)) then
    return jsonb_build_object('resumed',false,'reason','busy');
  end if;
  select * into v_plan from public.ve_contact_supply_plans where id=p_plan_id for update nowait;
  if not found or v_plan.status<>'error' or v_plan.updated_at is distinct from p_expected_updated_at
    or v_plan.item_id is null then
    return jsonb_build_object('resumed',false,'reason','plan_changed');
  end if;
  -- Automatic adoption is intentionally narrower than explicit manual retry:
  -- only a direct Requesty 402, never mixed or nested provider error text.
  if coalesce(v_plan.last_error,'') !~* '^[[:space:]]*Requesty[[:space:]]*(HTTP[[:space:]]*)?[:(]?[[:space:]]*402\M'
    or v_plan.last_error ~* '\m(Serper|OpenRouter|Polza)\M' then
    return jsonb_build_object('resumed',false,'reason','not_requesty_billing');
  end if;
  if exists(select 1 from public.ve_outreach_preparations p where p.project_id=v_plan.project_id
    and p.hypothesis_id=v_plan.hypothesis_id and (p.paused_at is not null or p.cancelled_at is not null)) then
    return jsonb_build_object('resumed',false,'reason','specialist_paused');
  end if;
  if not public.ve_contact_supply_approval_current(v_plan.id) then
    return jsonb_build_object('resumed',false,'reason','approval_changed');
  end if;
  if not exists(select 1 from public.ve_launch_queue_items qi where qi.id=v_plan.item_id
    and qi.project_id=v_plan.project_id and qi.hypothesis_id=v_plan.hypothesis_id and qi.status='active')
    or not exists(select 1 from public.ve_launch_queue_campaigns c where c.item_id=v_plan.item_id
      and c.remote_status in (1,3,4) and c.status_observed_at between p_now-interval '5 minutes' and p_now+interval '1 minute') then
    return jsonb_build_object('resumed',false,'reason','campaign_not_active');
  end if;
  select * into v_batch from public.ve_contact_supply_batches where plan_id=v_plan.id
    order by created_at desc,id desc limit 1 for update nowait;
  if not found or v_batch.status<>'failed' or v_batch.audit_id is not null then
    return jsonb_build_object('resumed',false,'reason','batch_changed');
  end if;
  select * into v_base from public.ve_bases where id=v_batch.base_id for update nowait;
  if not found or v_base.status<>'failed' or v_base.project_id<>v_plan.project_id
    or v_base.hypothesis_id is distinct from v_plan.hypothesis_id then
    return jsonb_build_object('resumed',false,'reason','base_changed');
  end if;
  if not exists(select 1 from unnest(array[v_base.error,v_base.collect_info->'target_progress'->>'reason']) error_text
      where error_text ~* '^[[:space:]]*Requesty[[:space:]]*(HTTP[[:space:]]*)?[:(]?[[:space:]]*402\M')
    or exists(select 1 from unnest(array[v_base.error,v_base.collect_info->'target_progress'->>'reason']) error_text
      where nullif(btrim(error_text),'') is not null
        and error_text !~* '^[[:space:]]*Requesty[[:space:]]*(HTTP[[:space:]]*)?[:(]?[[:space:]]*402\M')
    or concat_ws(' ',v_base.error,v_base.collect_info->'target_progress'->>'reason') ~* '\m(Serper|OpenRouter|Polza)\M' then
    return jsonb_build_object('resumed',false,'reason','not_requesty_billing');
  end if;
  -- A failed or still-running shared child has its own provider/key and
  -- lifecycle. Do not infer that its text authorizes this engine-key recovery.
  if coalesce(jsonb_typeof(v_base.collect_info->'tasks'),'array')<>'array' then
    return jsonb_build_object('resumed',false,'reason','child_state_unconfirmed');
  end if;
  if (v_base.collect_info->'construct' is not null and (
      v_base.collect_info->'construct'->>'status' is distinct from 'done'
      or not exists(select 1 from public.base_constructor_jobs c
        where c.id::text=v_base.collect_info->'construct'->>'bc_job_id' and c.status='completed')))
    or exists(select 1 from jsonb_array_elements(coalesce(v_base.collect_info->'tasks','[]'::jsonb)) task
      where jsonb_typeof(task) is distinct from 'object' or coalesce(task->>'status','') not in ('pending','done'))
    or coalesce(v_base.collect_info->'preview_pipeline','null'::jsonb)<>'null'::jsonb then
    return jsonb_build_object('resumed',false,'reason','child_state_unconfirmed');
  end if;
  select * into v_job from public.ve_jobs where project_id=v_plan.project_id and stage='base_collect'
    and payload->>'base_id'=v_base.id::text order by created_at desc,id desc limit 1 for update nowait;
  if not found or v_job.status not in ('done','failed')
    or coalesce(v_job.payload->'requesty_billing_wait','null'::jsonb)<>'null'::jsonb then
    return jsonb_build_object('resumed',false,'reason','job_changed');
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

  -- Reuse the tested atomic repair, but never present the old approver as the
  -- initiator: both durable receipts below record the automatic origin.
  begin
    perform public.ve_set_contact_supply_status(v_plan.id,'active',v_plan.approved_by,p_now);
    perform public.ve_require_contact_supply_active(v_plan.id,p_now);
    update public.ve_jobs set payload=payload||jsonb_build_object('requesty_billing_recovery',jsonb_build_object(
      'version',1,'source','legacy_supply','origin','automatic_requesty_credit',
      'key_fingerprint',p_key_fingerprint,'credit_signal',p_credit_signal,
      'credit_observed_at',p_credit_observed_at,'blocked_at',v_base.updated_at,'resumed_at',p_now))
      where id=v_job.id and status='pending' and payload->>'supply_batch_id'=v_batch.id::text;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception using errcode='40001',message='Legacy supply recovery lost its original job';
    end if;
    update public.ve_bases set collect_info=jsonb_set(collect_info,
      '{supply_billing_resume,origin}','"automatic_requesty_credit"'::jsonb)
      where id=v_base.id and status='collecting';
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception using errcode='40001',message='Legacy supply recovery lost its original base';
    end if;
  exception when raise_exception then
    -- The subtransaction rolls the explicit repair back as a unit. Known
    -- lifecycle/checkpoint refusal is a skip; DB/permission faults propagate.
    if sqlerrm ~ '^(Saved billing-failed supply |Previous supply attempt |Another supply batch |supply approval |supply plan is not active |supply requires active campaign |restore original launch bundle )' then
      return jsonb_build_object('resumed',false,'reason','checkpoint_not_resumable');
    end if;
    raise;
  end;
  return jsonb_build_object('resumed',true,'reason','credit_available');
exception when lock_not_available then
  return jsonb_build_object('resumed',false,'reason','busy');
end;
$$;

revoke all on function public.ve_resume_legacy_requesty_supply(uuid,timestamptz,text,jsonb,timestamptz,timestamptz)
  from public,anon,authenticated;
grant execute on function public.ve_resume_legacy_requesty_supply(uuid,timestamptz,text,jsonb,timestamptz,timestamptz)
  to service_role;
