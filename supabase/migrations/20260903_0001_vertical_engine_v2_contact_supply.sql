-- VE2 continuous supply: explicit preview approval, audited batch append,
-- and replenishment-aware lifecycle. Existing non-preview launches are unchanged.

create table public.ve_contact_supply_plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.ve_projects(id) on delete restrict,
  hypothesis_id uuid not null references public.ve_hypotheses(id) on delete restrict,
  template_id uuid not null unique references public.ve_templates(id) on delete restrict,
  item_id uuid unique references public.ve_launch_queue_items(id) on delete restrict,
  status text not null default 'approved'
    check (status in ('approved','active','paused','exhausted','limited','error')),
  approval_snapshot jsonb not null check (jsonb_typeof(approval_snapshot) = 'object'),
  preview_audit_id uuid not null references public.ve_segmentation_audits(id) on delete restrict,
  preview_audit_hash text not null,
  preview_revision text not null,
  approved_by uuid not null,
  approved_at timestamptz not null,
  source_state jsonb not null default '{}' check (jsonb_typeof(source_state) = 'object'),
  estimate jsonb not null default '{}' check (jsonb_typeof(estimate) = 'object'),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ve_contact_supply_plans_project on public.ve_contact_supply_plans(project_id, status);

create table public.ve_contact_supply_batches (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.ve_contact_supply_plans(id) on delete restrict,
  base_id uuid not null unique references public.ve_bases(id) on delete restrict,
  template_id uuid not null unique references public.ve_templates(id) on delete restrict,
  audit_id uuid references public.ve_segmentation_audits(id) on delete restrict,
  status text not null default 'collecting'
    check (status in ('collecting','auditing','ready','appended','failed')),
  requested_count integer not null check (requested_count between 1 and 5000),
  rules_snapshot jsonb not null check (jsonb_typeof(rules_snapshot) = 'object'),
  appended_count integer not null default 0 check (appended_count >= 0),
  append_snapshot jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ve_contact_supply_one_open_batch on public.ve_contact_supply_batches(plan_id)
  where status in ('collecting','auditing','ready');

alter table public.ve_templates add column supply_batch_id uuid
  references public.ve_contact_supply_batches(id) on delete restrict;
create unique index ve_templates_supply_batch on public.ve_templates(supply_batch_id)
  where supply_batch_id is not null;
alter table public.ve_segmentation_audits
  add column supply_leads jsonb check (supply_leads is null or jsonb_typeof(supply_leads) = 'array'),
  add column supply_source_revision text;
alter table public.ve_contact_delivery_rows
  add column supply_batch_id uuid references public.ve_contact_supply_batches(id) on delete restrict;
-- Original launch rows retain their original source index; subsequent source
-- indices belong to one immutable batch, not to the whole lifetime of an item.
alter table public.ve_contact_delivery_rows drop constraint ve_contact_delivery_rows_item_id_source_row_index_key;
create unique index ve_contact_delivery_initial_source on public.ve_contact_delivery_rows(item_id, source_row_index)
  where supply_batch_id is null;
create unique index ve_contact_delivery_batch_source on public.ve_contact_delivery_rows(supply_batch_id, source_row_index)
  where supply_batch_id is not null;

create function public.ve_contact_supply_targeting_snapshot(p_template_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('version',1,'template_id',t.id,'hypothesis_id',h.id,
    'project_id',p.id,'vertical_id',v.id,'letters',t.letters,'mapping',t.personalization_plan,
    'hypothesis',jsonb_build_object('title',h.title,'description',h.description,'fit_rationale',h.fit_rationale,'tier',h.tier,'status',h.status),
    'vertical',jsonb_build_object('name',v.name,'summary',v.summary,'synonyms',v.synonyms),
    'company_types',(select vv.company_types from public.ve_vocab vv where vv.vertical_id=v.id order by vv.created_at desc,vv.id desc limit 1),
    'targeting',jsonb_build_object('website_url',to_jsonb(p)->'website_url','brief',to_jsonb(p)->'brief','market',p.market))
  from public.ve_templates t join public.ve_bases b on b.id=t.base_id
  join public.ve_projects p on p.id=b.project_id
  join public.ve_hypotheses h on h.id=b.hypothesis_id and h.project_id=p.id
  join public.ve_verticals v on v.id=b.vertical_id and v.project_id=p.id
  where t.id=p_template_id and t.status='ready';
$$;

create function public.ve_contact_supply_preview_revision(p_template_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select md5(jsonb_build_object('base', b.id, 'source', b.source, 'columns', b.columns,
    'data', b.data, 'targeting',public.ve_contact_supply_targeting_snapshot(t.id))::text)
    from public.ve_templates t join public.ve_bases b on b.id=t.base_id where t.id=p_template_id;
$$;

create function public.ve_contact_supply_rules_snapshot(
  p_template_id uuid, p_preset_id text, p_portal_project_id uuid,
  p_portal_period_id uuid, p_target_contacts integer, p_instantly_account_id text
) returns jsonb language sql stable security definer set search_path = '' as $$
  select public.ve_contact_supply_targeting_snapshot(t.id) || jsonb_build_object(
    'preset_id',p_preset_id,'portal_project_id',p_portal_project_id,'portal_period_id',p_portal_period_id,
    'target_contacts',p_target_contacts,'instantly_account_id',p_instantly_account_id)
    from public.ve_templates t where t.id=p_template_id and t.supply_batch_id is null;
$$;

create function public.ve_contact_supply_approval_current(p_plan_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select
    s.approval_snapshot = public.ve_contact_supply_rules_snapshot(s.template_id,
      s.approval_snapshot->>'preset_id',(s.approval_snapshot->>'portal_project_id')::uuid,
      (s.approval_snapshot->>'portal_period_id')::uuid,(s.approval_snapshot->>'target_contacts')::integer,
      s.approval_snapshot->>'instantly_account_id')
    and (p.launch_preset_id is null or p.launch_preset_id::text=s.approval_snapshot->>'preset_id')
    and (p.launch_instantly_account_id is null or p.launch_instantly_account_id=s.approval_snapshot->>'instantly_account_id')
    and (p.portal_project_id is null or p.portal_project_id::text=s.approval_snapshot->>'portal_project_id')
    and (p.portal_period_id is null or p.portal_period_id::text=s.approval_snapshot->>'portal_period_id')
    and (p.target_contacts is null or p.target_contacts=(s.approval_snapshot->>'target_contacts')::integer)
    and (s.item_id is not null or (s.preview_revision=public.ve_contact_supply_preview_revision(s.template_id)
      and exists(select 1 from public.ve_segmentation_audits a where a.id=s.preview_audit_id
        and a.status='ready' and a.input_hash=s.preview_audit_hash)))
    from public.ve_contact_supply_plans s join public.ve_projects p on p.id=s.project_id
    where s.id=p_plan_id),false);
$$;

create function public.ve_approve_contact_supply(
  p_template_id uuid,p_audit_id uuid,p_expected_preview_revision text,p_preset_id text,
  p_portal_project_id uuid,p_portal_period_id uuid,p_target_contacts integer,
  p_instantly_account_id text,p_approved_by uuid,p_now timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_template public.ve_templates%rowtype; v_base public.ve_bases%rowtype;
  v_audit public.ve_segmentation_audits%rowtype; v_plan public.ve_contact_supply_plans%rowtype;
  v_snapshot jsonb; v_revision text;
begin
  if p_approved_by is null or p_now is null or p_target_contacts is null or p_target_contacts<=0
     or nullif(btrim(p_preset_id),'') is null or nullif(btrim(p_instantly_account_id),'') is null then
    raise exception 'complete explicit approval identity and contact obligation required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ve-supply-template:'||p_template_id::text,0));
  select * into v_template from public.ve_templates where id=p_template_id for share;
  select * into v_base from public.ve_bases where id=v_template.base_id for share;
  if v_template.id is null or v_template.status<>'ready' or v_template.supply_batch_id is not null
     or v_base.hypothesis_id is null or v_base.collect_info->>'collection_mode' is distinct from 'preview' then
    raise exception 'approval requires a ready hypothesis preview template';
  end if;
  if v_base.status not in ('analyzing','analyzed')
    or coalesce(v_base.collect_info->'target_progress'->>'status','') not in ('target_reached','exhausted','limited')
    or coalesce((v_base.collect_info->'target_progress'->>'ready_rows')::integer,0)<=0 then
    raise exception 'approval requires a terminal preview with ready contacts';
  end if;
  if exists(select 1 from public.ve_hypotheses where id=v_base.hypothesis_id and status='rejected') then
    raise exception 'rejected hypothesis cannot approve continuous supply';
  end if;
  if not exists(select 1 from public.project_periods pp where pp.id=p_portal_period_id
    and pp.project_id=p_portal_project_id and pp.status='active' and pp.deadline>=p_now::date) then
    raise exception 'approval requires the explicit active Portal period';
  end if;
  select * into v_audit from public.ve_segmentation_audits where id=p_audit_id for share;
  if v_audit.id is null or v_audit.template_id<>p_template_id or v_audit.base_id<>v_base.id
     or v_audit.status<>'ready' or v_audit.input_hash is null
     or coalesce((v_audit.summary->>'unclassified_rows_total')::integer,-1)<>0 then
    raise exception 'approval requires a complete current preview audit';
  end if;
  v_revision:=public.ve_contact_supply_preview_revision(p_template_id);
  if v_revision is distinct from p_expected_preview_revision then raise exception 'preview changed during approval'; end if;
  v_snapshot:=public.ve_contact_supply_rules_snapshot(p_template_id,p_preset_id,p_portal_project_id,
    p_portal_period_id,p_target_contacts,p_instantly_account_id);
  if v_snapshot is null then raise exception 'approval targeting snapshot unavailable'; end if;
  select * into v_plan from public.ve_contact_supply_plans where template_id=p_template_id for update;
  if found then
    if v_plan.item_id is not null and v_plan.approval_snapshot is distinct from v_snapshot then
      raise exception 'launched approval rules cannot change without reviewing existing campaigns';
    end if;
    update public.ve_contact_supply_plans set approval_snapshot=v_snapshot,preview_audit_id=p_audit_id,
      preview_audit_hash=v_audit.input_hash,preview_revision=v_revision,approved_by=p_approved_by,
      approved_at=p_now,status=case when item_id is null then 'approved' else status end,updated_at=p_now
      where id=v_plan.id returning * into v_plan;
  else
    insert into public.ve_contact_supply_plans(project_id,hypothesis_id,template_id,approval_snapshot,
      preview_audit_id,preview_audit_hash,preview_revision,approved_by,approved_at,updated_at)
    values(v_base.project_id,v_base.hypothesis_id,p_template_id,v_snapshot,p_audit_id,
      v_audit.input_hash,v_revision,p_approved_by,p_now,p_now) returning * into v_plan;
  end if;
  if not public.ve_contact_supply_approval_current(v_plan.id) then raise exception 'approval conflicts with project binding'; end if;
  return to_jsonb(v_plan);
end;
$$;

create function public.ve_set_contact_supply_status(p_plan_id uuid,p_status text,p_actor_id uuid,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_plan public.ve_contact_supply_plans%rowtype;
begin
  if p_actor_id is null or p_now is null or p_status not in ('paused','active') then
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
  -- An explicit retry after a failed audit reuses its validated source. It
  -- must not buy another source batch merely because an LLM call failed.
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

create function public.ve_pause_contact_supply_plan(p_plan_id uuid,p_error text,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_plan public.ve_contact_supply_plans%rowtype;
begin
  if p_now is null then raise exception 'pause timestamp required'; end if;
  update public.ve_contact_supply_plans set status='paused',last_error=left(p_error,1000),updated_at=p_now
    where id=p_plan_id returning * into v_plan;
  if not found then raise exception 'supply plan not found'; end if;
  return to_jsonb(v_plan);
end;
$$;

-- Initial launch and recovery share the existing finalizer, so one identity
-- trigger protects both, including callers that bypass the HTTP preflight.
create function public.ve_guard_contact_supply_launch()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_base public.ve_bases%rowtype; v_plan public.ve_contact_supply_plans%rowtype;
begin
  if exists(select 1 from public.ve_templates t where t.id=new.template_id and t.supply_batch_id is not null) then
    raise exception 'supply batch templates cannot create new campaigns';
  end if;
  select * into v_base from public.ve_bases where id=new.base_id;
  if v_base.collect_info->>'collection_mode'='preview' then
    select * into v_plan from public.ve_contact_supply_plans where template_id=new.template_id for update;
    if not found or v_plan.status not in ('approved','active')
      or not public.ve_contact_supply_approval_current(v_plan.id)
      or v_plan.preview_audit_id<>new.segmentation_audit_id
      or (v_plan.item_id is not null and v_plan.item_id<>new.id) then
      raise exception 'current explicit preview approval required before launch';
    end if;
  end if;
  return new;
end;
$$;
create trigger ve_launch_queue_supply_approval before insert on public.ve_launch_queue_items
for each row execute function public.ve_guard_contact_supply_launch();
create function public.ve_bind_contact_supply_item()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.ve_contact_supply_plans set item_id=new.id,status='active',updated_at=new.updated_at
    where template_id=new.template_id and item_id is null;
  return new;
end;
$$;
create trigger ve_launch_queue_supply_bind after insert on public.ve_launch_queue_items
for each row execute function public.ve_bind_contact_supply_item();

create function public.ve_require_contact_supply_active(p_plan_id uuid,p_now timestamptz)
returns public.ve_contact_supply_plans language plpgsql security definer set search_path = '' as $$
declare v_plan public.ve_contact_supply_plans%rowtype;
begin
  select * into v_plan from public.ve_contact_supply_plans where id=p_plan_id for update;
  if not found or v_plan.status<>'active' then raise exception 'supply plan is not active (paused or stopped)'; end if;
  if not public.ve_contact_supply_approval_current(p_plan_id) then raise exception 'supply approval rules are stale'; end if;
  if not exists(select 1 from public.ve_launch_queue_items qi join public.ve_projects p on p.id=qi.project_id
    join public.project_periods pp on pp.id=p.portal_period_id and pp.project_id=p.portal_project_id
    where qi.id=v_plan.item_id and qi.project_id=v_plan.project_id and qi.hypothesis_id=v_plan.hypothesis_id
      and qi.status='active' and qi.preset_id=p.launch_preset_id::text
      and qi.instantly_account_id=p.launch_instantly_account_id and pp.status='active'
      and pp.deadline>=timezone(p.delivery_timezone,p_now)::date
      and extract(dow from timezone(p.delivery_timezone,p_now))::smallint=any(p.delivery_schedule_days)
      and btrim(pp.contacts_done)~'^[0-9]+$' and btrim(pp.contacts_done)::numeric<p.target_contacts) then
    raise exception 'supply requires active campaign ownership and unfulfilled period';
  end if;
  return v_plan;
end;
$$;

create function public.ve_enqueue_contact_supply_batch(p_plan_id uuid,p_limit integer,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_plan public.ve_contact_supply_plans%rowtype; v_batch public.ve_contact_supply_batches%rowtype;
  v_template public.ve_templates%rowtype; v_base public.ve_bases%rowtype; v_new_base uuid; v_new_template uuid;
  v_job uuid; v_batch_id uuid:=gen_random_uuid(); v_info jsonb;
begin
  if p_limit is null or p_limit not between 1 and 5000 or p_now is null then raise exception 'invalid bounded supply target'; end if;
  v_plan:=public.ve_require_contact_supply_active(p_plan_id,p_now);
  select * into v_batch from public.ve_contact_supply_batches where plan_id=p_plan_id and status in ('collecting','auditing','ready') for update;
  if found then return jsonb_build_object('created',false,'batch',to_jsonb(v_batch),'base_id',v_batch.base_id); end if;
  select * into v_template from public.ve_templates where id=v_plan.template_id;
  select * into v_base from public.ve_bases where id=v_template.base_id;
  v_info:=jsonb_build_object('collection_mode','supply','ready_target',p_limit,'hypothesis_id',v_plan.hypothesis_id,
    'supply_batch_id',v_batch_id,'limit',greatest(1000,p_limit));
  insert into public.ve_bases(project_id,vertical_id,hypothesis_id,filename,source,status,collect_info)
    values(v_plan.project_id,v_base.vertical_id,v_plan.hypothesis_id,'supply: '||coalesce(v_base.filename,'hypothesis'),'auto','collecting',v_info)
    returning id into v_new_base;
  insert into public.ve_templates(base_id,vertical_id,letters,personalization_plan,status)
    values(v_new_base,v_template.vertical_id,v_template.letters,v_template.personalization_plan,'ready') returning id into v_new_template;
  insert into public.ve_contact_supply_batches(id,plan_id,base_id,template_id,requested_count,rules_snapshot,created_at,updated_at)
    values(v_batch_id,p_plan_id,v_new_base,v_new_template,p_limit,v_plan.approval_snapshot,p_now,p_now) returning * into v_batch;
  update public.ve_templates set supply_batch_id=v_batch_id where id=v_new_template;
  insert into public.ve_jobs(project_id,stage,status,payload)
    values(v_plan.project_id,'base_collect','pending',v_info||jsonb_build_object('base_id',v_new_base,'vertical_id',v_base.vertical_id)) returning id into v_job;
  return jsonb_build_object('created',true,'batch',to_jsonb(v_batch),'base_id',v_new_base,'job_id',v_job);
end;
$$;

create function public.ve_enqueue_contact_supply_audit(p_batch_id uuid,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_batch public.ve_contact_supply_batches%rowtype; v_plan public.ve_contact_supply_plans%rowtype;
  v_result record; v_base public.ve_bases%rowtype;
begin
  select * into v_batch from public.ve_contact_supply_batches where id=p_batch_id;
  v_plan:=public.ve_require_contact_supply_active(v_batch.plan_id,p_now);
  select * into v_batch from public.ve_contact_supply_batches where id=p_batch_id for update;
  if v_batch.audit_id is not null then return jsonb_build_object('audit_id',v_batch.audit_id,'status',v_batch.status); end if;
  select * into v_base from public.ve_bases where id=v_batch.base_id for share;
  if v_base.status not in ('analyzed','analyzing') or v_batch.status<>'collecting' then
    raise exception 'supply collection is not ready for audit';
  end if;
  if v_plan.approval_snapshot is distinct from v_batch.rules_snapshot then raise exception 'batch approval rules changed'; end if;
  select * into v_result from public.ve_enqueue_segmentation_audit(v_plan.project_id,v_batch.template_id,v_batch.base_id,v_plan.approved_by);
  update public.ve_jobs set payload=payload||jsonb_build_object('supply_batch_id',p_batch_id)
    where id=(v_result.job_row->>'id')::uuid;
  update public.ve_contact_supply_batches set audit_id=(v_result.audit_row->>'id')::uuid,status='auditing',updated_at=p_now
    where id=p_batch_id returning * into v_batch;
  return jsonb_build_object('audit_id',v_batch.audit_id,'status',v_batch.status);
end;
$$;

create function public.ve_append_contact_supply_batch(p_batch_id uuid,p_audit_id uuid,p_rows jsonb,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_plan public.ve_contact_supply_plans%rowtype; v_batch public.ve_contact_supply_batches%rowtype;
  v_audit public.ve_segmentation_audits%rowtype; v_template public.ve_templates%rowtype;
  v_row jsonb; v_index integer; v_payload jsonb; v_email text; v_segment text;
  v_campaign public.ve_launch_queue_campaigns%rowtype; v_order bigint; v_added integer:=0; v_count integer;
  v_seen integer[]:='{}';
begin
  if p_now is null or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>20000 then
    raise exception 'bounded audited supply rows required';
  end if;
  select * into v_batch from public.ve_contact_supply_batches where id=p_batch_id;
  if not found then raise exception 'supply batch not found'; end if;
  select * into v_plan from public.ve_contact_supply_plans where id=v_batch.plan_id for update;
  select * into v_batch from public.ve_contact_supply_batches where id=p_batch_id for update;
  if v_batch.status='appended' then
    if v_batch.audit_id is distinct from p_audit_id or v_batch.append_snapshot is distinct from p_rows then
      raise exception 'supply append replay differs from original snapshot';
    end if;
    return jsonb_build_object('appended_count',v_batch.appended_count,'replayed',true);
  end if;
  v_plan:=public.ve_require_contact_supply_active(v_plan.id,p_now);
  if v_batch.rules_snapshot is distinct from v_plan.approval_snapshot then raise exception 'batch approval rules changed'; end if;
  select * into v_audit from public.ve_segmentation_audits where id=p_audit_id for share;
  select * into v_template from public.ve_templates where id=v_batch.template_id for share;
  if v_batch.status not in ('auditing','ready') or v_batch.audit_id is distinct from p_audit_id
    or v_audit.template_id is distinct from v_batch.template_id or v_audit.base_id is distinct from v_batch.base_id
    or v_audit.status is distinct from 'ready' or v_audit.supply_leads is null
    or v_audit.supply_source_revision is distinct from public.ve_contact_supply_preview_revision(v_batch.template_id)
    or v_template.letters is distinct from v_plan.approval_snapshot->'letters'
    or v_template.personalization_plan is distinct from v_plan.approval_snapshot->'mapping'
    or coalesce((v_audit.summary->>'unclassified_rows_total')::integer,-1)<>0
    or jsonb_array_length(v_audit.assignments)<>jsonb_array_length(v_audit.supply_leads) then
    raise exception 'complete current audited supply snapshot required';
  end if;
  -- The shared period lock serializes append with today's selection. Project
  -- email uniqueness is still the final authority across different plans.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    've-contact-delivery-period:'||(v_plan.approval_snapshot->>'portal_period_id'),0));
  perform 1 from public.ve_launch_queue_items where id=v_plan.item_id for update;
  select coalesce(max(drip_order)+1,0) into v_order from public.ve_contact_delivery_rows where item_id=v_plan.item_id;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row->'source_row_index') is distinct from 'number'
      or (v_row->>'source_row_index')::numeric<0 or trunc((v_row->>'source_row_index')::numeric)<>(v_row->>'source_row_index')::numeric then
      raise exception 'supply row requires exact nonnegative source index';
    end if;
    v_index:=(v_row->>'source_row_index')::integer;
    if v_index=any(v_seen) or v_index>=jsonb_array_length(v_audit.supply_leads) then raise exception 'duplicate or unknown audited source index'; end if;
    v_seen:=array_append(v_seen,v_index); v_payload:=v_row->'lead_payload';
    if v_payload is distinct from v_audit.supply_leads->v_index then raise exception 'supply payload differs from audited source'; end if;
    v_email:=lower(nullif(btrim(v_payload->>'email'),''));
    if v_email is null or (v_row?'email_normalized' and v_row->>'email_normalized' is distinct from v_email) then
      raise exception 'supply email identity mismatch';
    end if;
    select count(*)::integer,min(a.value->>'segment') into v_count,v_segment
      from jsonb_array_elements(v_audit.assignments) a(value) where (a.value->>'row_index')::integer=v_index;
    if v_count<>1 then raise exception 'supply assignment missing or ambiguous'; end if;
    select * into v_campaign from public.ve_launch_queue_campaigns where item_id=v_plan.item_id and campaign_id=v_row->>'campaign_id' for update;
    if not found or v_campaign.segment is distinct from v_segment then raise exception 'supply campaign does not match audited segment'; end if;
    insert into public.ve_contact_delivery_rows(ve_project_id,item_id,campaign_row_id,source_row_index,
      supply_batch_id,email_normalized,lead_payload,drip_order,status,created_at,updated_at)
    values(v_plan.project_id,v_plan.item_id,v_campaign.id,v_index,p_batch_id,v_email,v_payload,v_order,'ready',p_now,p_now)
    on conflict(ve_project_id,email_normalized) do nothing;
    get diagnostics v_count=row_count;
    v_added:=v_added+v_count; v_order:=v_order+v_count;
  end loop;
  update public.ve_contact_supply_batches set status='appended',appended_count=v_added,
    append_snapshot=p_rows,updated_at=p_now where id=p_batch_id;
  -- Counters are cumulative after replenishment; the original template's
  -- launch_info.ready_leads_count remains the immutable initial approval fact.
  update public.ve_launch_queue_campaigns c set
    ready_leads_count=(select count(*) from public.ve_contact_delivery_rows r where r.campaign_row_id=c.id),
    ready_remaining_count=(select count(*) from public.ve_contact_delivery_rows r where r.campaign_row_id=c.id and r.status='ready'),
    leads_count=(select count(*) from public.ve_contact_delivery_rows r where r.campaign_row_id=c.id and r.status='accepted'),updated_at=p_now
    where c.item_id=v_plan.item_id;
  update public.ve_launch_queue_items qi set
    ready_leads_count=(select count(*) from public.ve_contact_delivery_rows r where r.item_id=qi.id),
    ready_remaining_count=(select count(*) from public.ve_contact_delivery_rows r where r.item_id=qi.id and r.status='ready'),updated_at=p_now
    where qi.id=v_plan.item_id;
  return jsonb_build_object('appended_count',v_added,'replayed',false);
end;
$$;

create function public.ve_finish_contact_supply_batch(p_batch_id uuid,p_status text,p_error text,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_batch public.ve_contact_supply_batches%rowtype; v_plan public.ve_contact_supply_plans%rowtype;
  v_progress jsonb; v_estimate jsonb;
begin
  if p_status not in ('active','exhausted','limited','error') or p_now is null then raise exception 'invalid supply outcome'; end if;
  select * into v_batch from public.ve_contact_supply_batches where id=p_batch_id;
  select * into v_plan from public.ve_contact_supply_plans where id=v_batch.plan_id for update;
  select * into v_batch from public.ve_contact_supply_batches where id=p_batch_id for update;
  if v_batch.id is null then raise exception 'supply batch not found'; end if;
  select collect_info->'target_progress',collect_info->'estimate' into v_progress,v_estimate
    from public.ve_bases where id=v_batch.base_id;
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

-- A temporarily empty ready buffer must not release an otherwise active,
-- approved stream. Paused/exhausted/limited/error streams do not hold empty slots.
create function public.ve_hold_continuous_supply_slot()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status in ('active','activating','uncertain') and new.status='released'
    and new.release_reason='Все кампании завершены'
    and exists(select 1 from public.ve_contact_supply_plans s join public.ve_projects p on p.id=s.project_id
      join public.project_periods pp on pp.id=p.portal_period_id and pp.project_id=p.portal_project_id
      where s.item_id=old.id and s.status='active' and public.ve_contact_supply_approval_current(s.id)
        and pp.status='active' and pp.deadline>=timezone(p.delivery_timezone,new.updated_at)::date
        and btrim(pp.contacts_done)~'^[0-9]+$' and btrim(pp.contacts_done)::numeric<p.target_contacts) then
    new.status:='active'; new.released_at:=old.released_at; new.release_reason:=old.release_reason;
  end if;
  return new;
end;
$$;
create trigger ve_launch_queue_hold_supply before update of status on public.ve_launch_queue_items
for each row execute function public.ve_hold_continuous_supply_slot();

-- Preserve the proven delivery machinery; wrap only its admission boundary.
alter function public.ve_reserve_contact_delivery_day(uuid,timestamptz,bigint) rename to ve_reserve_contact_delivery_day_before_supply;
create function public.ve_reserve_contact_delivery_day(p_ve_project_id uuid,p_now timestamptz,p_observed_ve_first_contacted bigint default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_period uuid; v_result jsonb; v_date date; v_continuous boolean;
begin
  select portal_period_id,timezone(delivery_timezone,p_now)::date into v_period,v_date from public.ve_projects where id=p_ve_project_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ve-contact-delivery-period:'||v_period::text,0));
  if exists(select 1 from public.ve_contact_supply_plans s join public.ve_launch_queue_items qi on qi.id=s.item_id
    where s.project_id=p_ve_project_id and qi.status='active' and not public.ve_contact_supply_approval_current(s.id)) then
    raise exception 'supply approval is stale; delivery stopped before provider work';
  end if;
  select exists(select 1 from public.ve_contact_supply_plans where project_id=p_ve_project_id) into v_continuous;
  if v_continuous then
    -- Only zero-work observations may reopen. Attempted/reserved/uncertain days
    -- retain the original immutable quota and all provider fences.
    delete from public.ve_contact_delivery_daily_runs r where r.portal_period_id=v_period and r.run_date=v_date
      and r.reservation_status='no_ready_rows' and r.reserved_count=0
      and not exists(select 1 from public.ve_contact_delivery_attempts a where a.run_id=r.id)
      and not exists(select 1 from public.ve_contact_delivery_rows d where d.run_id=r.id);
  end if;
  v_result:=public.ve_reserve_contact_delivery_day_before_supply(p_ve_project_id,p_now,p_observed_ve_first_contacted);
  return v_result;
end;
$$;

alter function public.ve_mark_contact_delivery_attempt(uuid,uuid,text,uuid[]) rename to ve_mark_contact_delivery_attempt_before_supply;
create function public.ve_mark_contact_delivery_attempt(p_run_id uuid,p_attempt_id uuid,p_campaign_id text,p_row_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.ve_contact_delivery_rows r join public.ve_contact_supply_plans s on s.item_id=r.item_id
    where r.id=any(p_row_ids) and not public.ve_contact_supply_approval_current(s.id)) then
    raise exception 'supply approval is stale; provider attempt blocked';
  end if;
  return public.ve_mark_contact_delivery_attempt_before_supply(p_run_id,p_attempt_id,p_campaign_id,p_row_ids);
end;
$$;
alter function public.ve_reserve_contact_delivery_activation(uuid,text,uuid,integer,timestamptz,timestamptz)
  rename to ve_reserve_contact_delivery_activation_before_supply;
create function public.ve_reserve_contact_delivery_activation(p_item_id uuid,p_campaign_id text,p_attempt_id uuid,
  p_remote_status integer,p_status_observed_at timestamptz,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.ve_contact_supply_plans s where s.item_id=p_item_id
    and not public.ve_contact_supply_approval_current(s.id)) then
    raise exception 'supply approval is stale; campaign activation blocked';
  end if;
  return public.ve_reserve_contact_delivery_activation_before_supply(p_item_id,p_campaign_id,p_attempt_id,p_remote_status,p_status_observed_at,p_now);
end;
$$;

alter table public.ve_contact_supply_plans enable row level security;
alter table public.ve_contact_supply_batches enable row level security;
revoke all on public.ve_contact_supply_plans,public.ve_contact_supply_batches from public,anon,authenticated,service_role;
grant select on public.ve_contact_supply_plans to service_role;
grant select on public.ve_contact_supply_batches to service_role;
grant all on public.ve_contact_supply_plans,public.ve_contact_supply_batches to postgres;
create policy ve_supply_plans_service_read on public.ve_contact_supply_plans for select to service_role using(true);
create policy ve_supply_batches_service_read on public.ve_contact_supply_batches for select to service_role using(true);
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname='readonly') then
    grant select on public.ve_contact_supply_plans,public.ve_contact_supply_batches to readonly;
  end if;
end $$;

-- No direct service-role mutation of approvals, source identities or ledger.
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('ve_contact_supply_targeting_snapshot','ve_contact_supply_preview_revision','ve_contact_supply_rules_snapshot',
      've_contact_supply_approval_current','ve_approve_contact_supply','ve_set_contact_supply_status',
      've_pause_contact_supply_plan',
      've_guard_contact_supply_launch','ve_bind_contact_supply_item','ve_require_contact_supply_active',
      've_enqueue_contact_supply_batch','ve_enqueue_contact_supply_audit','ve_append_contact_supply_batch',
      've_finish_contact_supply_batch','ve_hold_continuous_supply_slot',
      've_reserve_contact_delivery_day','ve_mark_contact_delivery_attempt','ve_reserve_contact_delivery_activation',
      've_reserve_contact_delivery_day_before_supply','ve_mark_contact_delivery_attempt_before_supply',
      've_reserve_contact_delivery_activation_before_supply') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',f.signature);
    execute format('grant execute on function %s to postgres',f.signature);
  end loop;
end $$;
grant execute on function public.ve_contact_supply_preview_revision(uuid),public.ve_contact_supply_approval_current(uuid),
  public.ve_approve_contact_supply(uuid,uuid,text,text,uuid,uuid,integer,text,uuid,timestamptz),
  public.ve_set_contact_supply_status(uuid,text,uuid,timestamptz),
  public.ve_pause_contact_supply_plan(uuid,text,timestamptz),
  public.ve_enqueue_contact_supply_batch(uuid,integer,timestamptz),public.ve_enqueue_contact_supply_audit(uuid,timestamptz),
  public.ve_append_contact_supply_batch(uuid,uuid,jsonb,timestamptz),public.ve_finish_contact_supply_batch(uuid,text,text,timestamptz),
  public.ve_reserve_contact_delivery_day(uuid,timestamptz,bigint),public.ve_mark_contact_delivery_attempt(uuid,uuid,text,uuid[]),
  public.ve_reserve_contact_delivery_activation(uuid,text,uuid,integer,timestamptz,timestamptz) to service_role;
