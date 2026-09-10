-- Internal VE2 only: a shared selection and durable preparation, no he_* writes.
create table if not exists public.ve_outreach_setups (
  project_id uuid primary key references public.ve_projects(id) on delete cascade,
  selected_hypothesis_ids uuid[] not null default '{}',
  approved_bases jsonb not null default '{}'::jsonb,
  language text not null default 'ru' check (language in ('ru','en','pl')),
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create table if not exists public.ve_outreach_preparations (
  project_id uuid not null references public.ve_projects(id) on delete cascade,
  hypothesis_id uuid not null references public.ve_hypotheses(id) on delete cascade,
  base_id uuid references public.ve_bases(id) on delete set null,
  template_id uuid references public.ve_templates(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','collecting','generating','ready','error')),
  language text not null default 'ru' check (language in ('ru','en','pl')),
  locked_until timestamptz,
  claim_token uuid,
  cancelled_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id,hypothesis_id)
);
alter table public.ve_outreach_setups enable row level security;
alter table public.ve_outreach_preparations enable row level security;
revoke all on public.ve_outreach_setups, public.ve_outreach_preparations from public, anon, authenticated;
grant all on public.ve_outreach_setups to service_role;
grant all on public.ve_outreach_preparations to service_role;

-- Guard every enqueue path, including the legacy internal template POST.
-- Do not cancel existing paid jobs silently if deployment finds old duplicates.
do $$ begin
  if exists(select 1 from public.ve_jobs where stage in ('base_analyze','template') and status in ('pending','running')
    and nullif(payload->>'base_id','') is not null group by project_id,stage,payload->>'base_id' having count(*)>1) then
    raise exception 'Resolve duplicate active VE2 base_analyze/template jobs before applying outreach setup';
  end if;
end $$;
create unique index ve_jobs_one_active_preparation_stage on public.ve_jobs(project_id,stage,(payload->>'base_id'))
  where stage in ('base_analyze','template') and status in ('pending','running') and nullif(payload->>'base_id','') is not null;

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
  update ve_outreach_setups set selected_hypothesis_ids=v_ids, language=p_language,
    approved_bases=case when v_ids=selected_hypothesis_ids and language=p_language then approved_bases else '{}'::jsonb end,
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
  insert into ve_outreach_preparations(project_id,hypothesis_id,language)
    select p_project_id,chosen.hypothesis_id,v_setup.language from unnest(v_setup.selected_hypothesis_ids) as chosen(hypothesis_id)
    on conflict(project_id,hypothesis_id) do update set
      status=case when ve_outreach_preparations.status='error' or (ve_outreach_preparations.status='ready'
        and (ve_outreach_preparations.base_id is null or ve_outreach_preparations.template_id is null)) then 'pending' else ve_outreach_preparations.status end,
      language=excluded.language, last_error=null, cancelled_at=null, updated_at=now();
end $$;

create or replace function public.ve_claim_outreach_preparation()
returns setof public.ve_outreach_preparations language plpgsql security definer set search_path=public as $$
declare v_row public.ve_outreach_preparations;
begin
  select p.* into v_row from ve_outreach_preparations p join ve_outreach_setups s using(project_id)
    where p.hypothesis_id=any(s.selected_hypothesis_ids) and p.language=s.language and p.status in ('pending','collecting','generating')
      and (p.locked_until is null or p.locked_until<now())
    order by p.updated_at for update of p skip locked limit 1;
  if not found then return; end if;
  update ve_outreach_preparations set locked_until=clock_timestamp()+interval '2 minutes',claim_token=gen_random_uuid(),updated_at=clock_timestamp()
    where project_id=v_row.project_id and hypothesis_id=v_row.hypothesis_id returning * into v_row;
  return next v_row;
end $$;

create or replace function public.ve_save_outreach_preparation(
  p_project_id uuid,p_hypothesis_id uuid,p_claim_token uuid,p_status text,p_base_id uuid,p_template_id uuid,
  p_error text,p_release boolean default true
) returns boolean language plpgsql security definer set search_path='' as $$
declare p public.ve_outreach_preparations%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  select * into p from public.ve_outreach_preparations where project_id=p_project_id and hypothesis_id=p_hypothesis_id for update;
  if not found or p_claim_token is null or p.claim_token is distinct from p_claim_token or p.locked_until is null or p.locked_until<=clock_timestamp()
    or not exists(select 1 from public.ve_outreach_setups s where s.project_id=p_project_id
      and p_hypothesis_id=any(s.selected_hypothesis_ids) and s.language=p.language) then return false; end if;
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
  if not found or p_claim_token is null or p.claim_token is distinct from p_claim_token or p.locked_until is null or p.locked_until<=clock_timestamp()
    or not exists(select 1 from public.ve_outreach_setups s where s.project_id=p_project_id
      and p_hypothesis_id=any(s.selected_hypothesis_ids) and s.language=p.language) then
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

create or replace function public.ve_cancel_outreach_preparations(p_project_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  update public.ve_outreach_preparations set status='error',last_error='Подготовка остановлена пользователем.',
    claim_token=null,locked_until=null,cancelled_at=clock_timestamp(),updated_at=clock_timestamp()
    where project_id=p_project_id and status in ('pending','collecting','generating');
  get diagnostics v_count=row_count;
  return v_count;
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
      and p_hypothesis_id=any(s.selected_hypothesis_ids) and s.language=p.language) then
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

-- An old worker can be between its claim check and base_collect enqueue when
-- Stop is pressed. Reject its late job even if the new base id was not saved.
create or replace function public.ve_outreach_preparation_cancel_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.stage not in ('base_collect','base_analyze','template') then return new; end if;
  if not exists(select 1 from public.ve_outreach_preparations p join public.ve_bases b
    on b.project_id=p.project_id and b.hypothesis_id=p.hypothesis_id
    where p.project_id=new.project_id and b.id::text=new.payload->>'base_id'
      and b.collect_info->>'collection_mode'='preview') then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.project_id::text,22082029));
  if exists(select 1 from public.ve_outreach_preparations p join public.ve_bases b
    on b.project_id=p.project_id and b.hypothesis_id=p.hypothesis_id
    where p.project_id=new.project_id and b.id::text=new.payload->>'base_id' and p.cancelled_at is not null) then
    raise exception 'Подготовка остановлена. Нажмите «Подготовить письма», чтобы продолжить.';
  end if;
  return new;
end $$;
create trigger ve_outreach_preparation_cancel_guard before insert on public.ve_jobs
  for each row execute function public.ve_outreach_preparation_cancel_guard();

create or replace function public.ve_approve_outreach_base(
  p_project_id uuid,p_revision bigint,p_base_id uuid,p_template_id uuid,p_reviewed_revision text,p_approved boolean,p_actor uuid
) returns public.ve_outreach_setups language plpgsql security definer set search_path=public as $$
declare v_setup public.ve_outreach_setups; v_revision text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  perform pg_advisory_xact_lock(hashtextextended(p_template_id::text,22082028));
  select * into v_setup from ve_outreach_setups where project_id=p_project_id for update;
  if not found or v_setup.revision is distinct from p_revision then raise exception 'Выбор изменился. Обновите страницу'; end if;
  if p_approved is null or p_actor is null or nullif(btrim(p_reviewed_revision),'') is null then raise exception 'Нужно явное решение о проверенной базе'; end if;
  if not exists(select 1 from ve_bases b join ve_templates t on t.base_id=b.id
    join ve_hypotheses h on h.id=b.hypothesis_id and h.project_id=b.project_id
    where b.id=p_base_id and b.project_id=p_project_id and b.hypothesis_id=any(v_setup.selected_hypothesis_ids)
      and h.status is distinct from 'rejected' and h.vertical_id is not null
      and t.id=p_template_id and t.supply_batch_id is null and t.status='ready' and b.status='analyzed'
      and b.collect_info->>'collection_mode'='preview')
    then raise exception 'База или письма ещё не готовы'; end if;
  v_revision:=ve_contact_supply_preview_revision(p_template_id);
  if v_revision is distinct from p_reviewed_revision then raise exception 'База или письма изменились. Проверьте новую версию'; end if;
  update ve_outreach_setups set approved_bases=case when p_approved then approved_bases||jsonb_build_object(p_base_id::text,
      jsonb_build_object('template_id',p_template_id,'revision',v_revision,'approved_at',now(),'approved_by',p_actor))
    else approved_bases-p_base_id::text end, revision=revision+1,updated_at=now(),updated_by=p_actor
    where project_id=p_project_id returning * into v_setup;
  return v_setup;
end $$;
revoke all on function public.ve_save_outreach_setup(uuid,bigint,uuid[],text,uuid),
 public.ve_request_outreach_preparation(uuid,bigint),public.ve_claim_outreach_preparation(),
 public.ve_save_outreach_preparation(uuid,uuid,uuid,text,uuid,uuid,text,boolean),
 public.ve_enqueue_outreach_preparation_job(uuid,uuid,uuid,uuid,text),
 public.ve_cancel_outreach_preparations(uuid), public.ve_outreach_preparation_cancel_guard(),
 public.ve_resume_outreach_cancelled_base(uuid,uuid,uuid,uuid),
 public.ve_approve_outreach_base(uuid,bigint,uuid,uuid,text,boolean,uuid) from public,anon,authenticated;
grant execute on function public.ve_save_outreach_setup(uuid,bigint,uuid[],text,uuid),
 public.ve_request_outreach_preparation(uuid,bigint),public.ve_claim_outreach_preparation(),
 public.ve_save_outreach_preparation(uuid,uuid,uuid,text,uuid,uuid,text,boolean),
 public.ve_enqueue_outreach_preparation_job(uuid,uuid,uuid,uuid,text),
 public.ve_cancel_outreach_preparations(uuid), public.ve_outreach_preparation_cancel_guard(),
 public.ve_resume_outreach_cancelled_base(uuid,uuid,uuid,uuid),
 public.ve_approve_outreach_base(uuid,bigint,uuid,uuid,text,boolean,uuid) to service_role;
