-- Review saved VE2 preview candidates atomically, without a second collection.
-- No historical rows or active campaigns are changed by installing this RPC.
create or replace function public.ve_enqueue_relevance_review(p_base_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b public.ve_bases%rowtype;
  j public.ve_jobs%rowtype;
  v_info jsonb;
begin
  select * into b from public.ve_bases where id=p_base_id for update;
  if not found then raise exception 'VE_REVIEW_NOT_FOUND'; end if;
  if b.source <> 'auto' or b.hypothesis_id is null
    or b.collect_info->>'collection_mode' is distinct from 'preview'
    or coalesce(b.collect_info->>'refill','false') <> 'false'
    or b.collect_info->>'supply_batch_id' is not null
    or b.collect_info->'target_progress' is null
    or b.collect_info->'target_checkpoint' is null then
    raise exception 'VE_REVIEW_UNSUPPORTED';
  end if;
  select * into j from public.ve_jobs where project_id=b.project_id
    and payload->>'base_id'=b.id::text and status in ('pending','running')
    order by created_at desc limit 1;
  if found then
    if b.status='collecting' and j.stage='base_collect' and j.payload->>'review_relevance'='true' then
      return jsonb_build_object('ok',true,'existing',true,'job_id',j.id,'base_id',b.id);
    end if;
    raise exception 'VE_REVIEW_BUSY';
  end if;
  if b.status not in ('failed','analyzed') then raise exception 'VE_REVIEW_BUSY'; end if;
  -- Approval also takes a shared lock on this base: the check and queue insert
  -- cannot interleave with approval of a different ready-audience snapshot.
  if exists(select 1 from public.ve_templates t where t.base_id=b.id and t.launch_info is not null)
    or exists(select 1 from public.ve_contact_supply_plans p join public.ve_templates t on t.id=p.template_id where t.base_id=b.id)
    or exists(select 1 from public.ve_launch_queue_items q where q.base_id=b.id)
    or exists(select 1 from public.ve_segmentation_audits a where a.base_id=b.id and a.launch_status <> 'idle') then
    raise exception 'VE_REVIEW_APPROVED';
  end if;
  if b.collect_info->'relevance_reserve'->>'version' is distinct from '1'
    or jsonb_typeof(b.collect_info->'relevance_reserve'->'rows') is distinct from 'array' then
    raise exception 'VE_REVIEW_EMPTY';
  end if;
  if not exists(select 1 from jsonb_array_elements(b.collect_info->'relevance_reserve'->'rows') r
    where r->'_ve_relevance'->>'status' in ('needs_review','error')
      or (not (r ? '_ve_relevance') and r->>'_relevance_unchecked'='true')) then
    raise exception 'VE_REVIEW_EMPTY';
  end if;
  v_info:=jsonb_set(b.collect_info,'{target_progress,status}','"collecting"'::jsonb);
  v_info:=v_info #- '{target_progress,reason}';
  update public.ve_bases set status='collecting',error=null,collect_info=v_info,updated_at=now() where id=b.id;
  insert into public.ve_jobs(project_id,stage,status,payload)
    values(b.project_id,'base_collect','pending',jsonb_build_object('base_id',b.id,
      'vertical_id',b.vertical_id,'hypothesis_id',b.hypothesis_id,'collection_mode','preview',
      'ready_target',1000,'review_relevance',true)) returning * into j;
  return jsonb_build_object('ok',true,'existing',false,'job_id',j.id,'base_id',b.id);
end;
$$;
revoke all on function public.ve_enqueue_relevance_review(uuid) from public, anon, authenticated;
grant execute on function public.ve_enqueue_relevance_review(uuid) to service_role;
