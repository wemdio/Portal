-- Allow individual/group launches without changing the project's preparation selection.
-- Retain approval/revision checks, one active request, locks and idempotency.
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
