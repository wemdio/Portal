-- Make the independent preparation pause and accepted launch mutually exclusive.
-- Keep idempotent launch replay, saved approvals, and unrelated hypotheses intact.
create or replace function public.ve_start_outreach(p_project_id uuid,p_actor_id uuid,p_idempotency_key uuid,p_request jsonb,p_request_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.ve_outreach_setups%rowtype; r public.ve_outreach_runs%rowtype;
  i jsonb; b public.ve_bases%rowtype; t public.ve_templates%rowtype; a public.ve_segmentation_audits%rowtype;
  chosen uuid[]; approved jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  if p_actor_id is null or p_idempotency_key is null or p_request_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_request->'items') is distinct from 'array'
    or jsonb_array_length(p_request->'items') not between 1 and 50 then
    raise exception 'VE_OUTREACH_INVALID_REQUEST';
  end if;
  select * into r from public.ve_outreach_runs where project_id=p_project_id and idempotency_key=p_idempotency_key;
  if found then
    if r.request_hash<>p_request_hash or r.request<>p_request then raise exception 'VE_OUTREACH_IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('existing',true,'run',to_jsonb(r));
  end if;
  select * into r from public.ve_outreach_runs where project_id=p_project_id and status in ('queued','running','waiting') limit 1;
  if found then
    if r.request_hash<>p_request_hash or r.request<>p_request then raise exception 'VE_OUTREACH_ALREADY_RUNNING'; end if;
    return jsonb_build_object('existing',true,'run',to_jsonb(r));
  end if;
  select * into s from public.ve_outreach_setups where project_id=p_project_id for update;
  if not found or s.revision is distinct from (p_request->>'setup_revision')::bigint then raise exception 'VE_OUTREACH_SETUP_STALE'; end if;
  select array_agg((v->>'hypothesis_id')::uuid order by (v->>'hypothesis_id')::uuid) into chosen
    from jsonb_array_elements(p_request->'items') v;
  -- A launch may contain any nonempty subset of the prepared hypotheses.
  -- Other hypotheses keep their preparation and approvals; nothing is auto-selected.
  if chosen is null or array_position(chosen,null) is not null
    or not (chosen <@ s.selected_hypothesis_ids)
    or cardinality(chosen)<>(select count(distinct h) from unnest(chosen) h) then raise exception 'VE_OUTREACH_SELECTION_STALE'; end if;
  -- Pause and Start share this project lock. A stale browser approval must
  -- not start a preparation paused after its last rendered overview.
  if exists(select 1 from public.ve_outreach_preparations p where p.project_id=p_project_id
    and p.hypothesis_id=any(chosen) and p.paused_at is not null) then
    raise exception 'Подготовка одной из выбранных баз на паузе. Продолжите её перед запуском.';
  end if;
  -- Sorted locks share the editor/approval reservation key, avoiding cross-template lock inversion.
  for i in select value from jsonb_array_elements(p_request->'items') order by value->>'template_id' loop
    perform pg_advisory_xact_lock(hashtextextended(i->>'template_id',22082028));
  end loop;
  for i in select value from jsonb_array_elements(p_request->'items') loop
    select * into b from public.ve_bases where id=(i->>'base_id')::uuid;
    select * into t from public.ve_templates where id=(i->>'template_id')::uuid;
    select * into a from public.ve_segmentation_audits where id=(i->>'segmentation_audit_id')::uuid;
    approved:=s.approved_bases->(i->>'base_id');
    if b.id is null or b.project_id<>p_project_id or b.hypothesis_id is distinct from (i->>'hypothesis_id')::uuid
      or b.status<>'analyzed' or b.collect_info->>'collection_mode' is distinct from 'preview'
      or t.id is null or t.base_id<>b.id or t.status<>'ready' or t.launch_info is not null
      or approved->>'template_id' is distinct from i->>'template_id'
      or approved->>'revision' is distinct from i->>'preview_revision'
      or public.ve_contact_supply_preview_revision(t.id) is distinct from i->>'preview_revision'
      or a.id is null or a.template_id<>t.id or a.base_id<>b.id or a.status<>'ready' or a.launch_status<>'idle' then
      raise exception 'VE_OUTREACH_APPROVAL_STALE';
    end if;
  end loop;
  insert into public.ve_outreach_runs(project_id,requested_by,setup_revision,idempotency_key,request_hash,request,items)
    values(p_project_id,p_actor_id,s.revision,p_idempotency_key,p_request_hash,p_request,
      (select jsonb_agg(v||'{"status":"queued"}'::jsonb) from jsonb_array_elements(p_request->'items') v)) returning * into r;
  insert into public.ve_jobs(project_id,stage,status,payload)
    values(p_project_id,'outreach_start','pending',jsonb_build_object('outreach_run_id',r.id));
  return jsonb_build_object('existing',false,'run',to_jsonb(r));
end; $$;

revoke all on function public.ve_start_outreach(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.ve_start_outreach(uuid,uuid,uuid,jsonb,text) to service_role;

create or replace function public.ve_pause_outreach_hypothesis_preparation(
  p_project_id uuid,p_revision bigint,p_hypothesis_id uuid
) returns void language plpgsql security definer set search_path='' as $$
declare s public.ve_outreach_setups; p public.ve_outreach_preparations; v_base record; v_job record; v_child record;
  state jsonb; jobs jsonb:='[]'::jsonb; children jsonb:='[]'::jsonb; stamp timestamptz:=clock_timestamp(); fence uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  select * into s from public.ve_outreach_setups where project_id=p_project_id for update;
  if not found or s.revision is distinct from p_revision then raise exception 'Выбор изменился. Обновите страницу'; end if;
  -- Creating the external campaign can take time before launch_info exists.
  -- An accepted launch owns its chosen hypotheses during that gap; siblings
  -- remain independently pausable.
  if exists(select 1 from public.ve_outreach_runs r where r.project_id=p_project_id
    and r.status in ('queued','running','waiting')
    and exists(select 1 from jsonb_array_elements(r.request->'items') item
      where item->>'hypothesis_id'=p_hypothesis_id::text)) then
    raise exception 'База уже передана в запуск. Дождитесь создания кампаний; отправкой управляйте в Instantly.';
  end if;
  select * into p from public.ve_outreach_preparations where project_id=p_project_id and hypothesis_id=p_hypothesis_id for update;
  if not found then
    -- Legacy direct collection may have a real preview worker but no automatic
    -- preparation row. Adopt only that durable active work, never invent it.
    if (select count(distinct b.id) from public.ve_bases b
      join public.ve_hypotheses h on h.id=b.hypothesis_id and h.project_id=b.project_id
      join public.ve_jobs j on j.payload->>'base_id'=b.id::text and j.project_id=b.project_id
      where b.project_id=p_project_id and b.hypothesis_id=p_hypothesis_id and b.source='auto'
        and b.collect_info->>'collection_mode'='preview' and h.status<>'rejected' and h.vertical_id is not null
        and j.status in ('pending','running') and j.stage in ('base_collect','base_analyze','template','base_reproject_contacts'))>1 then
      raise exception 'Для гипотезы выполняются несколько баз. Обновите страницу или обратитесь к администратору.';
    end if;
    select b.id,j.stage into v_base from public.ve_bases b
      join public.ve_hypotheses h on h.id=b.hypothesis_id and h.project_id=b.project_id
      join public.ve_jobs j on j.payload->>'base_id'=b.id::text and j.project_id=b.project_id
      where b.project_id=p_project_id and b.hypothesis_id=p_hypothesis_id and b.source='auto'
        and b.collect_info->>'collection_mode'='preview' and h.status<>'rejected' and h.vertical_id is not null
        and j.status in ('pending','running') and j.stage in ('base_collect','base_analyze','template','base_reproject_contacts')
      order by j.created_at desc,j.id desc limit 1;
    if not found then raise exception 'Подготовка ещё не началась'; end if;
    insert into public.ve_outreach_preparations(project_id,hypothesis_id,base_id,language,status,independent_control)
      values(p_project_id,p_hypothesis_id,v_base.id,s.language,
        case when v_base.stage='template' then 'generating' else 'collecting' end,true);
    select * into p from public.ve_outreach_preparations where project_id=p_project_id and hypothesis_id=p_hypothesis_id for update;
  end if;
  if p.paused_at is not null then return; end if;
  if exists(select 1 from public.ve_templates t join public.ve_bases b on b.id=t.base_id
    where b.project_id=p_project_id and b.hypothesis_id=p_hypothesis_id and t.launch_info is not null) then
    raise exception 'База уже в запуске. Поиском контактов управляйте в результатах.';
  end if;
  if p.status not in ('pending','collecting','generating') and not exists(
    select 1 from public.ve_jobs j join public.ve_bases b on b.id::text=j.payload->>'base_id'
    where b.project_id=p_project_id and b.hypothesis_id=p_hypothesis_id
      and b.collect_info->>'collection_mode'='preview' and j.status in ('pending','running')
      and j.stage in ('base_collect','base_analyze','template','base_reproject_contacts')) then return; end if;
  -- Take jobs before bases, matching the stage statement-level write fence.
  for v_job in select j.* from public.ve_jobs j join public.ve_bases b on b.id::text=j.payload->>'base_id'
    where b.project_id=p_project_id and b.hypothesis_id=p_hypothesis_id
      and b.collect_info->>'collection_mode'='preview' and j.status in ('pending','running')
      and j.stage in ('base_collect','base_analyze','template','base_reproject_contacts')
    order by j.id for update of j
  loop
    jobs:=jobs||jsonb_build_array(jsonb_build_object('id',v_job.id,'status',v_job.status));
    update public.ve_jobs set status='cancelled',started_at=null,finished_at=stamp,updated_at=stamp where id=v_job.id;
  end loop;
  for v_base in select b.id from public.ve_bases b where b.project_id=p_project_id and b.hypothesis_id=p_hypothesis_id
    and b.collect_info->>'collection_mode'='preview' for update
  loop
    perform public.ve_register_saved_preparation_children(v_base.id);
  end loop;
  for v_child in select c.* from public.ve_preparation_children link
    join public.ve_bases b on b.id=link.base_id
    join public.base_constructor_jobs c on c.id=link.child_id and link.kind='base_constructor_jobs'
    where b.project_id=p_project_id and b.hypothesis_id=p_hypothesis_id
      and b.collect_info->>'collection_mode'='preview' and c.status in ('pending','processing')
    order by c.id for update of c
  loop
    fence:=gen_random_uuid();
    children:=children||jsonb_build_array(jsonb_build_object('id',v_child.id,'status',v_child.status,'fence',fence));
    update public.base_constructor_jobs set status='cancelled',completed_at=stamp,run_token=fence where id=v_child.id;
  end loop;
  -- Existing free parser requests may finish and retain their results. They
  -- are not restarted; no new parser/paid child can be inserted while paused.
  state:=jsonb_build_object('version',1,'status',p.status,'jobs',jobs,'constructors',children);
  update public.ve_outreach_preparations set paused_at=stamp,pause_state=state,cancelled_at=stamp,independent_control=true,
    locked_until=null,claim_token=null,updated_at=stamp where project_id=p_project_id and hypothesis_id=p_hypothesis_id;
end $$;

revoke all on function public.ve_pause_outreach_hypothesis_preparation(uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function public.ve_pause_outreach_hypothesis_preparation(uuid,bigint,uuid) to service_role;
