-- Explicit per-hypothesis preparation control. This never launches/pauses an
-- Instantly campaign and never changes the collected audience or its budgets.
alter table public.ve_outreach_preparations
  add column if not exists paused_at timestamptz,
  add column if not exists pause_state jsonb,
  add column if not exists independent_control boolean not null default false;

-- Ownership is kept on the VE side: manual parser/constructor jobs are untouched.
create table if not exists public.ve_preparation_children (
  kind text not null check (kind in ('base_constructor_jobs','parser_jobs','google_maps_jobs')),
  child_id uuid not null,
  project_id uuid not null references public.ve_projects(id) on delete cascade,
  base_id uuid not null references public.ve_bases(id) on delete cascade,
  parent_job_id uuid references public.ve_jobs(id) on delete set null,
  request_key text,
  created_at timestamptz not null default now(),
  primary key(kind,child_id)
);
create unique index if not exists ve_preparation_child_request
  on public.ve_preparation_children(base_id,kind,request_key) where request_key is not null;
create index if not exists ve_preparation_children_base on public.ve_preparation_children(base_id);
alter table public.ve_preparation_children enable row level security;
revoke all on public.ve_preparation_children from public,anon,authenticated;
grant all on public.ve_preparation_children to service_role;

-- Stage writes carry the invocation identity, unlike HTTP/operator writes.
-- Statement triggers take the job lock BEFORE any base/template row lock.
-- That order agrees with Pause and cannot deadlock with an in-flight checkpoint.
create or replace function public.ve_guard_preparation_stage_write()
returns trigger language plpgsql security definer set search_path='' as $$
declare headers jsonb; job_id uuid; started timestamptz; j public.ve_jobs;
begin
  headers := nullif(current_setting('request.headers',true),'')::jsonb;
  if nullif(headers->>'x-ve-job-id','') is null then return null; end if;
  job_id := (headers->>'x-ve-job-id')::uuid;
  started := nullif(headers->>'x-ve-job-started-at','null')::timestamptz;
  if tg_table_name='ve_jobs' then
    -- Concurrent checkpoints must not both hold SHARE before upgrading.
    select * into j from public.ve_jobs where id=job_id for update;
  else
    select * into j from public.ve_jobs where id=job_id for share;
  end if;
  if not found or j.status<>'running' or j.started_at is distinct from started then
    raise exception 'VE_JOB_LEASE_LOST';
  end if;
  return null;
end $$;
drop trigger if exists ve_bases_preparation_stage_write on public.ve_bases;
create trigger ve_bases_preparation_stage_write before insert or update on public.ve_bases
  for each statement execute function public.ve_guard_preparation_stage_write();
drop trigger if exists ve_templates_preparation_stage_write on public.ve_templates;
create trigger ve_templates_preparation_stage_write before insert or update on public.ve_templates
  for each statement execute function public.ve_guard_preparation_stage_write();
-- Relevance/name checkpoints write ve_jobs.result inside stages as well.
-- Guard UPDATE only: INSERT has a separate project-first queue lock order.
drop trigger if exists ve_jobs_preparation_stage_write on public.ve_jobs;
create trigger ve_jobs_preparation_stage_write before update on public.ve_jobs
  for each statement execute function public.ve_guard_preparation_stage_write();

-- Late follow-up stage INSERTs must retain the parent generation too. Use the
-- existing row trigger, taking its project lock first, rather than a statement
-- trigger which would reverse the project's queue/paused-job lock order.
create or replace function public.ve_outreach_preparation_cancel_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare headers jsonb; parent public.ve_jobs;
begin
  if new.stage not in ('base_collect','base_analyze','template','base_reproject_contacts') then return new; end if;
  headers:=nullif(current_setting('request.headers',true),'')::jsonb;
  if nullif(headers->>'x-ve-job-id','') is null and not exists(
    select 1 from public.ve_outreach_preparations p join public.ve_bases b
      on b.project_id=p.project_id and b.hypothesis_id=p.hypothesis_id
      where p.project_id=new.project_id and b.id::text=new.payload->>'base_id'
        and b.collect_info->>'collection_mode'='preview') then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.project_id::text,22082029));
  if nullif(headers->>'x-ve-job-id','') is not null then
    select * into parent from public.ve_jobs where id=(headers->>'x-ve-job-id')::uuid for share;
    if not found or parent.project_id<>new.project_id or parent.status<>'running'
      or parent.started_at is distinct from nullif(headers->>'x-ve-job-started-at','null')::timestamptz then
      raise exception 'VE_JOB_LEASE_LOST';
    end if;
  end if;
  if exists(select 1 from public.ve_outreach_preparations p join public.ve_bases b
    on b.project_id=p.project_id and b.hypothesis_id=p.hypothesis_id
    where p.project_id=new.project_id and b.id::text=new.payload->>'base_id'
      and b.collect_info->>'collection_mode'='preview' and (p.cancelled_at is not null or p.paused_at is not null)) then
    raise exception 'VE_PREPARATION_PAUSED';
  end if;
  return new;
end $$;

-- Child insertion and pause share one project lock. A response lost after
-- commit resolves to the same child ID; it never resets a claimed/completed row.
create or replace function public.ve_enqueue_preparation_child(
  p_parent_job_id uuid,p_parent_started_at timestamptz,p_kind text,p_record jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare j public.ve_jobs; b public.ve_bases; child uuid; existing uuid; v_request_key text; owner uuid;
begin
  if p_kind not in ('base_constructor_jobs','parser_jobs','google_maps_jobs')
    or jsonb_typeof(p_record) is distinct from 'object' then raise exception 'Invalid VE child request'; end if;
  select * into j from public.ve_jobs where id=p_parent_job_id;
  if not found then raise exception 'VE_JOB_LEASE_LOST'; end if;
  perform pg_advisory_xact_lock(hashtextextended(j.project_id::text,22082029));
  select * into j from public.ve_jobs where id=p_parent_job_id for update;
  if j.status<>'running' or j.started_at is distinct from p_parent_started_at
    or j.stage<>'base_collect' then raise exception 'VE_JOB_LEASE_LOST'; end if;
  select * into b from public.ve_bases where id=(j.payload->>'base_id')::uuid and project_id=j.project_id;
  if not found then raise exception 'VE child base is unavailable'; end if;
  if b.collect_info->>'collection_mode'='preview' and exists(select 1 from public.ve_outreach_preparations p where p.project_id=b.project_id
    and p.hypothesis_id=b.hypothesis_id and (p.cancelled_at is not null or p.paused_at is not null)) then
    raise exception 'VE_PREPARATION_PAUSED';
  end if;
  select created_by into owner from public.ve_projects where id=j.project_id;
  if owner is null or (p_record->>'user_id')::uuid is distinct from owner then raise exception 'VE child owner mismatch'; end if;
  v_request_key := coalesce(nullif(p_record->>'id',''),md5(p_record::text));
  select c.child_id into existing from public.ve_preparation_children c
    where c.base_id=b.id and c.kind=p_kind and c.request_key=v_request_key;
  if found then return existing; end if;
  child := coalesce(nullif(p_record->>'id','')::uuid,gen_random_uuid());
  if exists(select 1 from public.ve_preparation_children c where c.kind=p_kind and c.child_id=child
    and (c.base_id<>b.id or c.project_id<>b.project_id)) then raise exception 'VE child identity mismatch'; end if;
  if p_kind='base_constructor_jobs' then
    insert into public.base_constructor_jobs(id,user_id,file_name,status,locale,workload_origin,
      selected_steps,step_config,data,initial_row_count,total_steps)
      values(child,owner,p_record->>'file_name',coalesce(p_record->>'status','pending'),coalesce(p_record->>'locale','ru'),'automation',
        coalesce(p_record->'selected_steps','[]'::jsonb),coalesce(p_record->'step_config','{}'::jsonb),p_record->'data',
        coalesce((p_record->>'initial_row_count')::integer,0),coalesce((p_record->>'total_steps')::integer,0))
      on conflict(id) do nothing;
    if not exists(select 1 from public.base_constructor_jobs c where c.id=child and c.user_id=owner
      and c.file_name is not distinct from p_record->>'file_name' and c.workload_origin='automation'
      and c.selected_steps=coalesce(p_record->'selected_steps','[]'::jsonb)) then raise exception 'VE constructor identity mismatch'; end if;
  elsif p_kind='parser_jobs' then
    if p_record->>'parser_type' is distinct from 'hh_vacancies' then raise exception 'Unsupported VE parser'; end if;
    insert into public.parser_jobs(id,user_id,parser_type,status,progress_stage,progress_percent,config)
      values(child,owner,'hh_vacancies','pending','pending',0,p_record->'config') on conflict(id) do nothing;
    if not exists(select 1 from public.parser_jobs c where c.id=child and c.user_id=owner
      and c.parser_type='hh_vacancies' and c.config=p_record->'config') then raise exception 'VE parser identity mismatch'; end if;
  else
    insert into public.google_maps_jobs(id,user_id,status,total_targets,config)
      values(child,owner,'queued',coalesce((p_record->>'total_targets')::integer,0),p_record->'config') on conflict(id) do nothing;
    if not exists(select 1 from public.google_maps_jobs c where c.id=child and c.user_id=owner
      and c.config=p_record->'config') then raise exception 'VE maps identity mismatch'; end if;
  end if;
  insert into public.ve_preparation_children(kind,child_id,project_id,base_id,parent_job_id,request_key)
    values(p_kind,child,b.project_id,b.id,j.id,v_request_key) on conflict(kind,child_id) do nothing;
  return child;
end $$;

-- Adopt already-paid legacy constructor identities only from this base's
-- durable checkpoint. No filename matching and no access to manual jobs.
create or replace function public.ve_register_saved_preparation_children(p_base_id uuid)
returns void language sql security definer set search_path='' as $$
  insert into public.ve_preparation_children(kind,child_id,project_id,base_id)
    select distinct 'base_constructor_jobs',c.id,b.project_id,b.id
      from public.ve_bases b
      cross join lateral (
        select b.collect_info->'construct'->>'bc_job_id' as id
        union select b.collect_info->'saved_email_recovery'->'batch'->>'id'
        union select b.collect_info->'adaptive_collection'->'pending'->>'id'
        union select x->>'id' from jsonb_array_elements(coalesce(b.collect_info->'preview_pipeline'->'batches','[]'::jsonb)) x
        union select x#>>'{}' from jsonb_array_elements(coalesce(b.collect_info->'preview_pipeline'->'job_ids','[]'::jsonb)) x
      ) ids
      join public.base_constructor_jobs c on c.id::text=ids.id
      join public.ve_projects p on p.id=b.project_id and p.created_by=c.user_id
     where b.id=p_base_id and c.workload_origin='automation'
    on conflict(kind,child_id) do nothing;
$$;

create or replace function public.ve_pause_outreach_hypothesis_preparation(
  p_project_id uuid,p_revision bigint,p_hypothesis_id uuid
) returns void language plpgsql security definer set search_path='' as $$
declare s public.ve_outreach_setups; p public.ve_outreach_preparations; v_base record; v_job record; v_child record;
  state jsonb; jobs jsonb:='[]'::jsonb; children jsonb:='[]'::jsonb; stamp timestamptz:=clock_timestamp(); fence uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  select * into s from public.ve_outreach_setups where project_id=p_project_id for update;
  if not found or s.revision is distinct from p_revision then raise exception 'Выбор изменился. Обновите страницу'; end if;
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

-- Called only from an explicit single-hypothesis Continue under the project
-- lock. It restores the same children and jobs, never resets paid checkpoints.
create or replace function public.ve_resume_paused_preparation(p_project_id uuid,p_hypothesis_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare p public.ve_outreach_preparations; item jsonb; stamp timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  select * into p from public.ve_outreach_preparations where project_id=p_project_id and hypothesis_id=p_hypothesis_id for update;
  if not found or p.paused_at is null then return false; end if;
  if p.pause_state->>'version' is distinct from '1' then raise exception 'Состояние паузы недоступно. Обновите страницу.'; end if;
  if exists(select 1 from public.ve_templates t where t.base_id=p.base_id and t.launch_info is not null) then
    raise exception 'База уже передана в запуск'; end if;
  -- Remove the durable fence only within this transaction; a rollback restores it.
  update public.ve_outreach_preparations set paused_at=null,cancelled_at=null,locked_until=null,claim_token=null,
    status=case when p.pause_state->>'status' in ('pending','collecting','generating') then p.pause_state->>'status' else 'collecting' end,
    updated_at=stamp where project_id=p_project_id and hypothesis_id=p_hypothesis_id;
  for item in select value from jsonb_array_elements(coalesce(p.pause_state->'constructors','[]'::jsonb))
  loop
    -- 'processing' plus an expired lease is deliberate: pending would replay
    -- already completed steps because the constructor treats it as a fresh job.
    update public.base_constructor_jobs c set
      status=case when item->>'status'='processing' then 'processing' else 'pending' end,
      started_at=case when item->>'status'='processing' then stamp-interval '1 hour' else null end,
      completed_at=null,run_token=gen_random_uuid()
      where c.id=(item->>'id')::uuid and c.status='cancelled' and c.run_token=(item->>'fence')::uuid
        and exists(select 1 from public.ve_preparation_children link join public.ve_bases b on b.id=link.base_id
          where link.kind='base_constructor_jobs' and link.child_id=c.id
            and b.project_id=p_project_id and b.hypothesis_id=p_hypothesis_id);
    if not found then raise exception 'Состояние сохранённой проверки изменилось. Обновите страницу.'; end if;
  end loop;
  for item in select value from jsonb_array_elements(coalesce(p.pause_state->'jobs','[]'::jsonb))
  loop
    -- Analysis may have saved its result immediately before Pause cancelled
    -- the final job write. Reuse that artifact instead of buying it again.
    update public.ve_jobs j set
      status=case when j.stage='base_analyze' and b.status='analyzed' and jsonb_typeof(b.analysis)='object' then 'done' else 'pending' end,
      started_at=null,
      finished_at=case when j.stage='base_analyze' and b.status='analyzed' and jsonb_typeof(b.analysis)='object' then stamp else null end,
      run_after=stamp,updated_at=stamp
      from public.ve_bases b
      where j.id=(item->>'id')::uuid and j.project_id=p_project_id and j.status='cancelled'
        and j.finished_at=p.paused_at
        and b.id::text=j.payload->>'base_id' and b.project_id=p_project_id and b.hypothesis_id=p_hypothesis_id;
    if not found then raise exception 'Состояние сохранённой задачи изменилось. Обновите страницу.'; end if;
  end loop;
  -- Keep exact base identity through the first coordinator tick: a pending
  -- retry must not adopt an older finished duplicate after this explicit resume.
  update public.ve_outreach_preparations set pause_state=case when p.base_id is null then null
      else jsonb_build_object('resumed_base_id',p.base_id) end
    where project_id=p_project_id and hypothesis_id=p_hypothesis_id;
  return true;
end $$;

revoke all on function public.ve_guard_preparation_stage_write(),
  public.ve_enqueue_preparation_child(uuid,timestamptz,text,jsonb),public.ve_register_saved_preparation_children(uuid),
  public.ve_pause_outreach_hypothesis_preparation(uuid,bigint,uuid),public.ve_resume_paused_preparation(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.ve_guard_preparation_stage_write(),
  public.ve_enqueue_preparation_child(uuid,timestamptz,text,jsonb),public.ve_register_saved_preparation_children(uuid),
  public.ve_pause_outreach_hypothesis_preparation(uuid,bigint,uuid),public.ve_resume_paused_preparation(uuid,uuid)
  to service_role;

-- Existing coordinator contracts retain legacy selection semantics until an
-- explicit preparation/control/selection action opts that hypothesis in.

create or replace function public.ve_save_outreach_setup(
  p_project_id uuid, p_revision bigint, p_hypothesis_ids uuid[], p_language text, p_actor uuid
) returns public.ve_outreach_setups language plpgsql security definer set search_path=public as $$
declare v_setup public.ve_outreach_setups; v_ids uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 22082029));
  if p_project_id is null or p_revision is null or p_revision<1 or p_actor is null
    or p_hypothesis_ids is null or array_position(p_hypothesis_ids,null) is not null then raise exception 'Некорректный выбор гипотез'; end if;
  if not exists (select 1 from ve_projects where id=p_project_id) then raise exception 'Проект не найден'; end if;
  insert into ve_outreach_setups(project_id) values(p_project_id) on conflict do nothing;
  select * into v_setup from ve_outreach_setups where project_id=p_project_id for update;
  if v_setup.revision<>p_revision then raise exception 'Выбор изменился. Обновите страницу'; end if;
  if p_language is null or p_language not in ('ru','en','pl') then raise exception 'Неподдерживаемый язык'; end if;
  select coalesce(array_agg(distinct chosen.hypothesis_id order by chosen.hypothesis_id),'{}'::uuid[])
    into v_ids from unnest(p_hypothesis_ids) as chosen(hypothesis_id);
  if cardinality(v_ids)>50 then raise exception 'Можно выбрать не более 50 гипотез'; end if;
  if exists(select 1 from unnest(v_ids) as chosen(hypothesis_id) where not exists(
    select 1 from ve_hypotheses h where h.id=chosen.hypothesis_id and h.project_id=p_project_id and h.vertical_id is not null and h.status is distinct from 'rejected'
  )) then raise exception 'Выберите доступные гипотезы этого проекта'; end if;
  if exists(select 1 from ve_outreach_preparations p where p.project_id=p_project_id and p.hypothesis_id=any(v_ids)
    and p.language<>p_language and (p.base_id is not null or p.template_id is not null or p.status<>'pending'
      or p.locked_until>clock_timestamp())) then
    raise exception 'Для выбранных гипотез подготовка уже началась на другом языке. Продолжите на прежнем языке или создайте отдельный проект.';
  end if;
  -- A selection change is no longer an implicit pause of previously started work.
  -- Opt in only preparations that were selected before this explicit edit;
  -- untouched legacy unselected preparations must not wake after deployment.
  update public.ve_outreach_preparations set independent_control=true
    where project_id=p_project_id and hypothesis_id=any(v_setup.selected_hypothesis_ids);
  update ve_outreach_setups set selected_hypothesis_ids=v_ids, language=p_language,
    approved_bases=case when language=p_language then approved_bases else '{}'::jsonb end,
    revision=revision+1, updated_at=now(), updated_by=p_actor where project_id=p_project_id returning * into v_setup;
  return v_setup;
end $$;

create or replace function public.ve_request_outreach_preparation(p_project_id uuid,p_revision bigint)
returns void language plpgsql security definer set search_path=public as $$
declare v_setup public.ve_outreach_setups;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  select * into v_setup from ve_outreach_setups where project_id=p_project_id for update;
  if not found or v_setup.revision is distinct from p_revision then raise exception 'Выбор изменился. Обновите страницу'; end if;
  if cardinality(v_setup.selected_hypothesis_ids)=0 then raise exception 'Выберите гипотезы'; end if;
  if exists(select 1 from ve_outreach_preparations p where p.project_id=p_project_id
    and p.hypothesis_id=any(v_setup.selected_hypothesis_ids) and p.language<>v_setup.language
    and (p.base_id is not null or p.template_id is not null or p.status<>'pending' or p.locked_until>clock_timestamp())) then
    raise exception 'Язык сохранённой подготовки не совпадает с выбором. Верните прежний язык.';
  end if;
  insert into ve_outreach_preparations(project_id,hypothesis_id,language,independent_control)
    select p_project_id,chosen.hypothesis_id,v_setup.language,true from unnest(v_setup.selected_hypothesis_ids) as chosen(hypothesis_id)
    on conflict(project_id,hypothesis_id) do update set
      status=case when ve_outreach_preparations.status='error' or (ve_outreach_preparations.status='ready'
        and (ve_outreach_preparations.base_id is null or ve_outreach_preparations.template_id is null)) then 'pending' else ve_outreach_preparations.status end,
      language=excluded.language, last_error=null, cancelled_at=null, updated_at=now(),independent_control=true
    where ve_outreach_preparations.paused_at is null;
end $$;

create or replace function public.ve_request_outreach_hypothesis_preparation(
  p_project_id uuid, p_revision bigint, p_hypothesis_id uuid, p_resume_collection boolean default false
) returns void language plpgsql security definer set search_path='' as $$
declare v_setup public.ve_outreach_setups;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  select * into v_setup from public.ve_outreach_setups where project_id=p_project_id for update;
  if not found or v_setup.revision is distinct from p_revision then
    raise exception 'Выбор изменился. Обновите страницу';
  end if;
  if p_hypothesis_id is null or not exists(select 1 from public.ve_hypotheses h where h.id=p_hypothesis_id
      and h.project_id=p_project_id and h.vertical_id is not null and h.status is distinct from 'rejected') then
    raise exception 'Выберите доступную гипотезу этого проекта';
  end if;
  if exists(select 1 from public.ve_outreach_preparations p where p.project_id=p_project_id
    and p.hypothesis_id=p_hypothesis_id and p.language<>v_setup.language
    and (p.base_id is not null or p.template_id is not null or p.status<>'pending' or p.locked_until>clock_timestamp())) then
    raise exception 'Язык сохранённой подготовки не совпадает с выбором. Верните прежний язык.';
  end if;
  -- Selecting one saved/new hypothesis for preparation is additive and never
  -- invalidates another base's approval.
  if not (p_hypothesis_id=any(v_setup.selected_hypothesis_ids)) then
    if cardinality(v_setup.selected_hypothesis_ids)>=50 then raise exception 'Можно выбрать не более 50 гипотез'; end if;
    update public.ve_outreach_setups set selected_hypothesis_ids=(select array_agg(x order by x)
      from unnest(v_setup.selected_hypothesis_ids||p_hypothesis_id) x),revision=revision+1,updated_at=clock_timestamp()
      where project_id=p_project_id;
  end if;
  if public.ve_resume_paused_preparation(p_project_id,p_hypothesis_id) then return; end if;
  insert into public.ve_outreach_preparations as prep(project_id,hypothesis_id,language,resume_collection_requested,independent_control)
    values(p_project_id,p_hypothesis_id,v_setup.language,coalesce(p_resume_collection,false),true)
    on conflict(project_id,hypothesis_id) do update set
      status='pending', language=excluded.language, last_error=null, cancelled_at=null,
      locked_until=null, claim_token=null, updated_at=clock_timestamp(),
      resume_collection_requested=excluded.resume_collection_requested,independent_control=true
    where (prep.locked_until is null or prep.locked_until<=clock_timestamp())
      and not exists(select 1 from public.ve_jobs j
        where j.project_id=prep.project_id and j.payload->>'base_id'=prep.base_id::text
          and j.stage in ('base_collect','base_analyze','template','base_reproject_contacts')
          and j.status in ('pending','running'))
      and not exists(select 1 from public.ve_templates t
        where t.base_id=prep.base_id and t.launch_info is not null);
end $$;

create or replace function public.ve_save_outreach_preparation(
  p_project_id uuid,p_hypothesis_id uuid,p_claim_token uuid,p_status text,p_base_id uuid,p_template_id uuid,
  p_error text,p_release boolean default true
) returns boolean language plpgsql security definer set search_path='' as $$
declare p public.ve_outreach_preparations%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  select * into p from public.ve_outreach_preparations where project_id=p_project_id and hypothesis_id=p_hypothesis_id for update;
  if not found or p.cancelled_at is not null or p.paused_at is not null or p_claim_token is null or p.claim_token is distinct from p_claim_token or p.locked_until is null or p.locked_until<=clock_timestamp()
    or not exists(select 1 from public.ve_outreach_setups s where s.project_id=p_project_id
      and (p.independent_control or (p_hypothesis_id=any(s.selected_hypothesis_ids) and s.language=p.language))) then return false; end if;
  if p_status is null or p_status not in ('pending','collecting','generating','ready','error') then raise exception 'Некорректный статус подготовки'; end if;
  if p_base_id is not null and not exists(select 1 from public.ve_bases b where b.id=p_base_id
    and b.project_id=p_project_id and b.hypothesis_id=p_hypothesis_id and b.source='auto'
    and b.collect_info->>'collection_mode'='preview') then raise exception 'База не принадлежит выбранной гипотезе'; end if;
  if p_template_id is not null and not exists(select 1 from public.ve_templates t where t.id=p_template_id
    and t.base_id=p_base_id and t.supply_batch_id is null) then raise exception 'Письма не принадлежат выбранной базе'; end if;
  if p_status='ready' and (p_base_id is null or p_template_id is null
    or not exists(select 1 from public.ve_bases b join public.ve_templates t on t.base_id=b.id
      where b.id=p_base_id and b.status='analyzed' and t.id=p_template_id and t.status='ready')) then
    raise exception 'База или письма ещё не готовы';
  end if;
  update public.ve_outreach_preparations set status=p_status,base_id=p_base_id,template_id=p_template_id,
    last_error=left(p_error,500),updated_at=clock_timestamp(),
    pause_state=case when p_release and p_status<>'pending' then null else pause_state end,
    locked_until=case when p_release then null else locked_until end,
    claim_token=case when p_release then null else claim_token end
    where project_id=p_project_id and hypothesis_id=p_hypothesis_id;
  return true;
end $$;

create or replace function public.ve_enqueue_outreach_preparation_job(
  p_project_id uuid,p_hypothesis_id uuid,p_claim_token uuid,p_base_id uuid,p_stage text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.ve_outreach_preparations%rowtype; b public.ve_bases%rowtype; j public.ve_jobs%rowtype;
  v_language text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  select * into p from public.ve_outreach_preparations where project_id=p_project_id and hypothesis_id=p_hypothesis_id for update;
  if not found or p.cancelled_at is not null or p.paused_at is not null or p_claim_token is null or p.claim_token is distinct from p_claim_token or p.locked_until is null or p.locked_until<=clock_timestamp()
    or not exists(select 1 from public.ve_outreach_setups s where s.project_id=p_project_id
      and (p.independent_control or (p_hypothesis_id=any(s.selected_hypothesis_ids) and s.language=p.language))) then
    raise exception 'VE_OUTREACH_PREPARATION_LEASE_LOST';
  end if;
  if p_stage is null or p_stage not in ('base_analyze','template') then raise exception 'Неподдерживаемая стадия подготовки'; end if;
  select * into b from public.ve_bases where id=p_base_id and project_id=p_project_id and hypothesis_id=p_hypothesis_id for update;
  if not found or b.source<>'auto' or b.collect_info->>'collection_mode' is distinct from 'preview'
    or (p_stage='template' and b.status<>'analyzed') or (p_stage='base_analyze' and b.status<>'analyzing') then
    raise exception 'База ещё не готова к выбранной стадии';
  end if;
  select * into j from public.ve_jobs where project_id=p_project_id and stage=p_stage
    and payload->>'base_id'=p_base_id::text and status in ('pending','running') order by created_at,id limit 1;
  if not found then
    begin
      insert into public.ve_jobs(project_id,stage,status,payload) values(p_project_id,p_stage,'pending',
        jsonb_build_object('base_id',p_base_id,'language',p.language,'final_only',true)) returning * into j;
    exception when unique_violation then
      select * into j from public.ve_jobs where project_id=p_project_id and stage=p_stage
        and payload->>'base_id'=p_base_id::text and status in ('pending','running') order by created_at,id limit 1;
      if not found then raise; end if;
    end;
  end if;
  if p_stage='template' then
    v_language:=j.payload->>'language';
    if v_language is null then
      select coalesce(pr.brief->>'language',(select c.language from public.ve_chains c where c.vertical_id=b.vertical_id
        order by c.created_at desc,c.id desc limit 1),'ru') into v_language from public.ve_projects pr where pr.id=p_project_id;
      if v_language not in ('en','pl') then v_language:='ru'; end if;
    end if;
    if v_language is distinct from p.language then raise exception 'Письма уже готовятся на другом языке. Дождитесь завершения и проверьте настройки.'; end if;
  end if;
  update public.ve_outreach_preparations set base_id=p_base_id,status=case when p_stage='template' then 'generating' else 'collecting' end,
    last_error=null,updated_at=clock_timestamp() where project_id=p_project_id and hypothesis_id=p_hypothesis_id;
  return to_jsonb(j);
end $$;

create or replace function public.ve_resume_outreach_cancelled_base(
  p_project_id uuid,p_hypothesis_id uuid,p_claim_token uuid,p_base_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.ve_outreach_preparations%rowtype; b public.ve_bases%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  select * into p from public.ve_outreach_preparations where project_id=p_project_id and hypothesis_id=p_hypothesis_id for update;
  if not found or p_claim_token is null or p.claim_token is distinct from p_claim_token or p.cancelled_at is not null
    or p.locked_until is null or p.locked_until<=clock_timestamp()
    or not exists(select 1 from public.ve_outreach_setups s where s.project_id=p_project_id
      and (p.independent_control or (p_hypothesis_id=any(s.selected_hypothesis_ids) and s.language=p.language))) then
    raise exception 'VE_OUTREACH_PREPARATION_LEASE_LOST';
  end if;
  select * into b from public.ve_bases where id=p_base_id and project_id=p_project_id and hypothesis_id=p_hypothesis_id for update;
  if not found or b.status<>'failed' or b.source<>'auto' or b.error is distinct from 'Отменено пользователем'
    or b.collect_info->>'collection_mode' is distinct from 'preview' then raise exception 'Нет сохранённой отменённой подготовки'; end if;
  update public.ve_bases set status=case when collect_info->'target_progress'->>'status' in ('target_reached','exhausted','limited')
      and coalesce(collect_info->'target_progress'->>'ready_rows','0')~'^[1-9][0-9]*$' then 'analyzing' else 'collecting' end,
    error=null,updated_at=clock_timestamp() where id=p_base_id returning * into b;
  update public.ve_outreach_preparations set base_id=p_base_id,updated_at=clock_timestamp()
    where project_id=p_project_id and hypothesis_id=p_hypothesis_id;
  return to_jsonb(b);
end $$;

create or replace function public.ve_completed_preparation_recoverable(
  p_project_id uuid, p_hypothesis_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.ve_outreach_preparations p
      join public.ve_outreach_setups s on s.project_id = p.project_id
      join public.ve_hypotheses h on h.id = p.hypothesis_id and h.project_id = p.project_id
      join public.ve_bases b on b.id = p.base_id and b.project_id = p.project_id
        and b.hypothesis_id = p.hypothesis_id
      cross join lateral (
        select j.status, j.created_at, j.finished_at
          from public.ve_jobs j
         where j.project_id = p.project_id and j.stage = 'base_analyze'
           and j.payload->>'base_id' = b.id::text
         order by j.created_at desc, j.id desc limit 1
      ) analysis_job
     where p.project_id = p_project_id and p.hypothesis_id = p_hypothesis_id
       and p.status = 'error' and p.cancelled_at is null
       and (p.locked_until is null or p.locked_until < now())
       and (p.independent_control or (p.hypothesis_id = any(s.selected_hypothesis_ids) and p.language = s.language))
       and h.status <> 'rejected' and h.vertical_id is not null
       and b.source = 'auto' and b.status = 'analyzed' and b.error is null and b.row_count > 0
       and jsonb_typeof(b.analysis) = 'object'
       and b.collect_info->>'collection_mode' = 'preview'
       and b.collect_info->'target_progress'->>'status' in ('target_reached', 'limited', 'exhausted')
       and analysis_job.status = 'done' and analysis_job.finished_at is not null
       and (
         p.last_error in (
           'Сбор базы остановлен. Нажмите «Продолжить подготовку»',
           'Разбор базы остановлен. Нажмите «Продолжить подготовку»',
           'Задача сбора завершилась, но база не готова. Нажмите «Продолжить подготовку»',
           'База ещё не готова к выбранной стадии'
         )
         -- A successful analysis AFTER the read failure proves the old
         -- coordinator error is obsolete. Do not retry a newer failure.
         or (analysis_job.finished_at > p.updated_at and p.last_error ~*
           '^(An invalid response was received from the upstream server|(?:TypeError: )?fetch failed|network error|(?:statement |request )?timeout)\.?$')
       )
       and not (s.approved_bases ? b.id::text)
       and not public.ve_base_audience_frozen(b.id)
       and not exists (select 1 from public.ve_templates t
         where t.base_id = b.id and t.launch_info is not null)
       and not exists (select 1 from public.ve_jobs j
         where j.project_id = p.project_id and j.payload->>'base_id' = b.id::text
           and j.status in ('pending', 'running'))
       and (select j.status from public.ve_jobs j
         where j.project_id = p.project_id and j.payload->>'base_id' = b.id::text
           and j.stage = 'base_collect'
         order by j.created_at desc, j.id desc limit 1) = 'done'
       and not exists (select 1 from public.ve_jobs j
         where j.project_id = p.project_id and j.payload->>'base_id' = b.id::text
           and j.stage = 'template' and j.status in ('failed', 'cancelled')
           and j.created_at >= analysis_job.created_at)
  );
$$;

create or replace function public.ve_claim_outreach_preparation()
returns setof public.ve_outreach_preparations
language plpgsql security definer set search_path = '' as $$
declare
  candidate record;
  v_row public.ve_outreach_preparations;
begin
  for candidate in
    select p.project_id, p.hypothesis_id
      from public.ve_outreach_preparations p
      join public.ve_outreach_setups s using(project_id)
     where (p.independent_control or (p.hypothesis_id = any(s.selected_hypothesis_ids) and p.language = s.language))
       and p.cancelled_at is null
       and (p.locked_until is null or p.locked_until < now())
       and (p.status in ('pending', 'collecting', 'generating')
         or public.ve_completed_preparation_recoverable(p.project_id, p.hypothesis_id))
     order by p.updated_at, p.project_id, p.hypothesis_id
     limit 32
  loop
    -- Same lock order as explicit preparation/cancellation. Never wait behind
    -- an operator transaction while holding the preparation row lock.
    if not pg_try_advisory_xact_lock(hashtextextended(candidate.project_id::text, 22082029)) then
      continue;
    end if;
    -- Recheck after the project lock: selection, cancellation or approval may
    -- have changed since the candidate scan, including in another worker.
    select p.* into v_row
      from public.ve_outreach_preparations p
      join public.ve_outreach_setups s using(project_id)
     where p.project_id = candidate.project_id and p.hypothesis_id = candidate.hypothesis_id
       and (p.independent_control or (p.hypothesis_id = any(s.selected_hypothesis_ids) and p.language = s.language))
       and p.cancelled_at is null
       and (p.locked_until is null or p.locked_until < now())
       and (p.status in ('pending', 'collecting', 'generating')
         or public.ve_completed_preparation_recoverable(p.project_id, p.hypothesis_id))
     for update of p skip locked;
    if not found then continue; end if;
    update public.ve_outreach_preparations
       -- NOT pending: pending explicitly grants another collection attempt
       -- below 500. Here only the completed analysis may advance to letters.
       set status = case when v_row.status = 'error' then 'collecting' else v_row.status end,
           last_error = case when v_row.status = 'error' then null else v_row.last_error end,
           locked_until = clock_timestamp() + interval '2 minutes',
           claim_token = gen_random_uuid(), updated_at = clock_timestamp()
     where project_id = v_row.project_id and hypothesis_id = v_row.hypothesis_id
     returning * into v_row;
    return next v_row;
    return;
  end loop;
end;
$$;
