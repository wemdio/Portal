-- One specialist-authorized project launch survives HTTP disconnects and worker restarts.
-- External campaign creation and activation retain their existing durable reservations.
create table public.ve_outreach_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.ve_projects(id) on delete cascade,
  requested_by uuid not null,
  setup_revision bigint not null,
  idempotency_key uuid not null,
  request_hash text not null,
  request jsonb not null,
  items jsonb not null,
  confirmation_kind text not null default 'specialist_attests_customer_approval'
    check (confirmation_kind = 'specialist_attests_customer_approval'),
  status text not null default 'queued' check (status in ('queued','running','waiting','active','blocked','cancelled')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(project_id,idempotency_key),
  check (jsonb_typeof(request)='object' and jsonb_typeof(items)='array')
);
create unique index ve_outreach_runs_one_active on public.ve_outreach_runs(project_id)
  where status in ('queued','running','waiting');
create index ve_outreach_runs_project_created on public.ve_outreach_runs(project_id,created_at desc);
alter table public.ve_outreach_runs enable row level security;
revoke all on public.ve_outreach_runs from public,anon,authenticated;
grant all on public.ve_outreach_runs to service_role,postgres;
do $$ begin if exists(select 1 from pg_roles where rolname='readonly') then
  grant select on public.ve_outreach_runs to readonly;
end if; end $$;

alter table public.ve_jobs drop constraint if exists ve_jobs_stage_check;
alter table public.ve_jobs add constraint ve_jobs_stage_check check(stage in (
  'site_profile','competitors','brand_cloud','hypotheses','evidence','clustering',
  'chain','vocab','base_analyze','base_collect','template','dossier','segmentation_audit','outreach_start'
));
create unique index ve_jobs_one_active_outreach_run on public.ve_jobs((payload->>'outreach_run_id'))
  where stage='outreach_start' and status in ('pending','running');

create function public.ve_start_outreach(p_project_id uuid,p_actor_id uuid,p_idempotency_key uuid,p_request jsonb,p_request_hash text)
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
  if chosen is distinct from (select array_agg(h order by h) from unnest(s.selected_hypothesis_ids) h)
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

create function public.ve_save_outreach_progress(p_run_id uuid,p_job_id uuid,p_status text,p_items jsonb,p_error text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.ve_jobs%rowtype;
begin
  select * into j from public.ve_jobs where id=p_job_id for update;
  if not found or j.status<>'running' or j.stage<>'outreach_start'
    or j.payload->>'outreach_run_id' is distinct from p_run_id::text then return false; end if;
  update public.ve_outreach_runs set status=p_status,items=p_items,error=left(p_error,500),updated_at=now(),
    finished_at=case when p_status in ('active','blocked','cancelled') then now() else null end
    where id=p_run_id and project_id=j.project_id and status in ('queued','running','waiting');
  return found;
end; $$;

create function public.ve_outreach_setup_edit_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(old.project_id::text,22082029));
  if exists(select 1 from public.ve_outreach_runs where project_id=old.project_id and status in ('queued','running','waiting')) then
    raise exception 'VE_OUTREACH_ALREADY_RUNNING';
  end if;
  return new;
end; $$;
create trigger ve_outreach_setup_edit_guard before update on public.ve_outreach_setups
  for each row execute function public.ve_outreach_setup_edit_guard();

create function public.ve_outreach_job_terminal() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.stage='outreach_start' and new.status in ('failed','cancelled') then
    update public.ve_outreach_runs set status=case when new.status='cancelled' then 'cancelled' else 'blocked' end,
      error=case when new.status='cancelled' then 'Подготовка запуска отменена. Уже работающие кампании продолжают отправку.' else left(new.error,500) end,
      updated_at=now(),finished_at=now()
      where id::text=new.payload->>'outreach_run_id' and status in ('queued','running','waiting');
  end if;
  return new;
end; $$;
create trigger ve_outreach_job_terminal after update of status on public.ve_jobs
  for each row when(new.status in ('failed','cancelled')) execute function public.ve_outreach_job_terminal();

revoke all on function public.ve_start_outreach(uuid,uuid,uuid,jsonb,text),public.ve_save_outreach_progress(uuid,uuid,text,jsonb,text),
  public.ve_outreach_setup_edit_guard(),public.ve_outreach_job_terminal() from public,anon,authenticated;
grant execute on function public.ve_start_outreach(uuid,uuid,uuid,jsonb,text),public.ve_save_outreach_progress(uuid,uuid,text,jsonb,text),
  public.ve_outreach_setup_edit_guard(),public.ve_outreach_job_terminal() to service_role;
