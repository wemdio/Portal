-- Vertical Engine v2: persisted pre-launch segmentation audits.
--
-- The reviewed assignment snapshot lives only in ve_* storage.  Launch reads
-- it after an explicit specialist confirmation; no he_* object is touched.

-- ─── ve_segmentation_audits ─────────────────────────────────────────────

create table if not exists public.ve_segmentation_audits (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.ve_projects(id) on delete cascade,
  template_id   uuid not null references public.ve_templates(id) on delete cascade,
  base_id       uuid not null references public.ve_bases(id) on delete cascade,
  requested_by  uuid not null,
  status        text not null default 'pending'
    check (status in ('pending','running','ready','failed','cancelled')),
  input_hash    text,
  segment_keys  jsonb not null default '[]'::jsonb,
  summary       jsonb,
  assignments   jsonb not null default '[]'::jsonb,
  error         text,
  tokens_used   bigint not null default 0,
  cost_usd      numeric(12,6) not null default 0,
  completed_at  timestamptz,
  launch_status text not null default 'idle'
    check (launch_status in ('idle','running','succeeded','failed','uncertain')),
  launch_reservation_id uuid,
  launch_preset_id text,
  launch_started_at timestamptz,
  launch_heartbeat_at timestamptz,
  launch_completed_at timestamptz,
  launch_error text,
  launch_resolution_id uuid,
  launch_resolved_by uuid,
  launch_resolved_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint ve_segmentation_audits_input_hash_check
    check (input_hash is null or input_hash ~ '^[0-9a-f]{64}$'),
  constraint ve_segmentation_audits_segment_keys_check
    check (jsonb_typeof(segment_keys) = 'array'),
  constraint ve_segmentation_audits_assignments_check
    check (jsonb_typeof(assignments) = 'array'),
  constraint ve_segmentation_audits_ready_payload_check
    check (status <> 'ready' or (input_hash is not null and summary is not null))
);

create index if not exists idx_ve_segmentation_audits_template_created
  on public.ve_segmentation_audits(template_id, created_at desc);

create index if not exists idx_ve_segmentation_audits_project_created
  on public.ve_segmentation_audits(project_id, created_at desc);

-- POST is idempotent while work is active.  The API performs a friendly
-- check first; this partial unique index closes the concurrent-request race.
create unique index if not exists ve_segmentation_audits_one_active_per_template
  on public.ve_segmentation_audits(template_id)
  where status in ('pending','running');

-- A template can have several historical ready audits, but only one request
-- may cross the external-mutation boundary.  `uncertain` deliberately keeps
-- the lock after a partial/unknown Instantly outcome until an operator reviews
-- it; failing open here would create duplicate paused campaigns and leads.
create unique index if not exists ve_segmentation_audits_one_launch_reservation
  on public.ve_segmentation_audits(template_id)
  where launch_status in ('running','uncertain');

comment on table public.ve_segmentation_audits is
  'Vertical Engine v2 pre-launch segmentation audit snapshots and row assignments.';

comment on column public.ve_segmentation_audits.input_hash is
  'SHA-256 hex of current template/base audience, segment conditions and persisted assignments.';

alter table public.ve_segmentation_audits enable row level security;

grant all on public.ve_segmentation_audits to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.ve_segmentation_audits to readonly';
  end if;
end $$;

-- ─── ve_jobs: dedicated asynchronous worker stage ──────────────────────

alter table public.ve_jobs
  drop constraint if exists ve_jobs_stage_check;

alter table public.ve_jobs
  add constraint ve_jobs_stage_check
  check (stage in (
    'site_profile','competitors','brand_cloud','hypotheses','evidence','clustering',
    'chain','vocab','base_analyze','base_collect','template','dossier',
    'segmentation_audit'
  ));

-- The RPC below creates the audit row and queue row in one transaction.  Keep
-- the partial index as a second invariant for legacy/direct writers.
create unique index if not exists ve_jobs_one_active_segmentation_audit
  on public.ve_jobs ((payload ->> 'audit_id'))
  where stage = 'segmentation_audit'
    and status in ('pending','running')
    and payload ? 'audit_id';

-- ─── Transactional audit/job lifecycle ─────────────────────────────────

create or replace function public.ve_enqueue_segmentation_audit(
  p_project_id uuid,
  p_template_id uuid,
  p_base_id uuid,
  p_requested_by uuid
)
returns table(audit_row jsonb, job_row jsonb, created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_audit public.ve_segmentation_audits%rowtype;
  v_job public.ve_jobs%rowtype;
begin
  -- Project lock is shared with cancellation; template lock serializes POSTs.
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 22082027));
  perform pg_advisory_xact_lock(hashtextextended(p_template_id::text, 22082026));

  select a.*
    into v_audit
    from public.ve_segmentation_audits a
   where a.template_id = p_template_id
     and a.status in ('pending','running')
   order by a.created_at desc
   limit 1
   for update;

  if found then
    select j.*
      into v_job
      from public.ve_jobs j
     where j.project_id = v_audit.project_id
       and j.stage = 'segmentation_audit'
       and j.payload ->> 'audit_id' = v_audit.id::text
     order by j.created_at desc
     limit 1;

    if v_job.id is null then
      -- Recovery for a legacy/direct-write orphan. Calls through this RPC
      -- create both rows atomically and never enter this branch.
      insert into public.ve_jobs(project_id, stage, status, payload)
      values (
        v_audit.project_id,
        'segmentation_audit',
        'pending',
        jsonb_build_object(
          'audit_id', v_audit.id,
          'template_id', v_audit.template_id,
          'base_id', v_audit.base_id
        )
      )
      returning * into v_job;
    elsif v_job.status in ('failed','cancelled','done') then
      update public.ve_segmentation_audits
         set status = case when v_job.status = 'cancelled' then 'cancelled' else 'failed' end,
             error = case
               when v_job.status = 'cancelled' then 'Отменено пользователем'
               else coalesce(v_job.error, 'Задача аудита завершилась без снимка')
             end,
             completed_at = coalesce(v_job.finished_at, now()),
             updated_at = now()
       where id = v_audit.id
       returning * into v_audit;
    end if;

    return query
      select to_jsonb(v_audit), to_jsonb(v_job), false;
    return;
  end if;

  insert into public.ve_segmentation_audits(
    project_id,
    template_id,
    base_id,
    requested_by,
    status
  )
  values (p_project_id, p_template_id, p_base_id, p_requested_by, 'pending')
  returning * into v_audit;

  insert into public.ve_jobs(project_id, stage, status, payload)
  values (
    p_project_id,
    'segmentation_audit',
    'pending',
    jsonb_build_object(
      'audit_id', v_audit.id,
      'template_id', p_template_id,
      'base_id', p_base_id
    )
  )
  returning * into v_job;

  return query
    select to_jsonb(v_audit), to_jsonb(v_job), true;
end;
$$;

create or replace function public.ve_cancel_segmentation_audits(
  p_project_id uuid,
  p_now timestamptz,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  -- Serialize against enqueue, including its legacy orphan-repair branch.
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 22082027));

  with cancelled_jobs as (
    update public.ve_jobs
       set status = 'cancelled',
           error = p_error,
           finished_at = p_now,
           updated_at = p_now
     where project_id = p_project_id
       and stage = 'segmentation_audit'
       and status in ('pending','running')
     returning payload ->> 'audit_id' as audit_id
  ),
  cancelled_audits as (
    update public.ve_segmentation_audits a
       set status = 'cancelled',
           error = p_error,
           completed_at = p_now,
           launch_status = case
             when a.launch_status = 'running' then 'uncertain'
             else a.launch_status
           end,
           launch_error = case
             when a.launch_status = 'running'
               then 'Проект отменён во время запуска. Проверьте кампании в Instantly.'
             else a.launch_error
           end,
           launch_completed_at = case
             when a.launch_status = 'running' then p_now
             else a.launch_completed_at
           end,
           updated_at = p_now
     where a.project_id = p_project_id
       and (
         a.status in ('pending','running')
         or a.id::text in (
           select cj.audit_id from cancelled_jobs cj where cj.audit_id is not null
         )
         or a.launch_status in ('running','uncertain')
       )
     returning a.id
  )
  select jsonb_build_object(
    'jobs', (select count(*) from cancelled_jobs),
    'audits', (select count(*) from cancelled_audits)
  )
  into v_result;

  return v_result;
end;
$$;

-- The external caller and the audit row cross the terminal boundary together.
-- An old process whose reservation was reconciled cannot overwrite launch_info.
create or replace function public.ve_finalize_template_launch(
  p_audit_id uuid,
  p_template_id uuid,
  p_launch_reservation_id uuid,
  p_launch_status text,
  p_launch_info jsonb,
  p_error text,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_audit public.ve_segmentation_audits%rowtype;
begin
  if p_launch_status not in ('succeeded','failed','uncertain') then
    raise exception 'invalid launch status: %', p_launch_status;
  end if;
  if p_launch_status = 'succeeded' and p_launch_info is null then
    raise exception 'succeeded launch requires launch_info';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_template_id::text, 22082028));

  select a.*
    into v_audit
    from public.ve_segmentation_audits a
   where a.id = p_audit_id
     and a.template_id = p_template_id
     and a.launch_reservation_id = p_launch_reservation_id
     and a.status = 'ready'
     and a.launch_status = 'running'
   for update;

  if not found then
    return jsonb_build_object('finalized', false);
  end if;

  if p_launch_info is not null then
    update public.ve_templates
       set launch_info = p_launch_info
     where id = p_template_id;
    if not found then
      raise exception 'template % not found', p_template_id;
    end if;
  end if;

  update public.ve_segmentation_audits
     set launch_status = p_launch_status,
         launch_error = nullif(left(coalesce(p_error, ''), 500), ''),
         launch_heartbeat_at = p_now,
         launch_completed_at = p_now,
         updated_at = p_now
   where id = p_audit_id
   returning * into v_audit;

  return jsonb_build_object(
    'finalized', true,
    'audit_row', to_jsonb(v_audit),
    'launch_info', p_launch_info
  );
end;
$$;

-- Explicit operator reconciliation. The exact original reservation is part of
-- the CAS, so a stale browser tab cannot resolve a later force attempt.
create or replace function public.ve_resolve_template_launch(
  p_audit_id uuid,
  p_template_id uuid,
  p_launch_reservation_id uuid,
  p_resolution text,
  p_launch_info jsonb,
  p_resolved_by uuid,
  p_resolution_id uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_audit public.ve_segmentation_audits%rowtype;
  v_existing_launch jsonb;
  v_terminal_status text;
begin
  if p_resolution not in ('no_campaign','campaign_created') then
    raise exception 'invalid launch resolution: %', p_resolution;
  end if;
  if p_resolution = 'campaign_created' and p_launch_info is null then
    raise exception 'campaign_created resolution requires launch_info';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_template_id::text, 22082028));

  select a.*
    into v_audit
    from public.ve_segmentation_audits a
   where a.id = p_audit_id
     and a.template_id = p_template_id
     and a.launch_reservation_id = p_launch_reservation_id
     and a.launch_status = 'uncertain'
   for update;

  if not found then
    return jsonb_build_object('resolved', false);
  end if;

  select t.launch_info
    into v_existing_launch
    from public.ve_templates t
   where t.id = p_template_id
   for update;
  if not found then
    raise exception 'template % not found', p_template_id;
  end if;

  if p_resolution = 'no_campaign' then
    if v_existing_launch ->> 'segmentation_audit_id' = p_audit_id::text
       and coalesce(v_existing_launch ->> 'campaign_id', '') <> '' then
      raise exception 'known campaign exists for this audit';
    end if;
    v_terminal_status := 'failed';
  else
    update public.ve_templates
       set launch_info = p_launch_info
     where id = p_template_id;
    v_terminal_status := 'succeeded';
  end if;

  update public.ve_segmentation_audits
     set launch_status = v_terminal_status,
         launch_error = case
           when p_resolution = 'no_campaign'
             then 'Специалист подтвердил: кампания не создана'
           else null
         end,
         launch_resolution_id = p_resolution_id,
         launch_resolved_by = p_resolved_by,
         launch_resolved_at = p_now,
         launch_completed_at = p_now,
         updated_at = p_now
   where id = p_audit_id
   returning * into v_audit;

  return jsonb_build_object(
    'resolved', true,
    'audit_row', to_jsonb(v_audit),
    'launch_info', case when p_resolution = 'campaign_created' then p_launch_info else null end
  );
end;
$$;

revoke all on function public.ve_enqueue_segmentation_audit(uuid, uuid, uuid, uuid) from public;
revoke all on function public.ve_cancel_segmentation_audits(uuid, timestamptz, text) from public;
revoke all on function public.ve_finalize_template_launch(uuid, uuid, uuid, text, jsonb, text, timestamptz) from public;
revoke all on function public.ve_resolve_template_launch(uuid, uuid, uuid, text, jsonb, uuid, uuid, timestamptz) from public;
grant execute on function public.ve_enqueue_segmentation_audit(uuid, uuid, uuid, uuid)
  to service_role, postgres;
grant execute on function public.ve_cancel_segmentation_audits(uuid, timestamptz, text)
  to service_role, postgres;
grant execute on function public.ve_finalize_template_launch(uuid, uuid, uuid, text, jsonb, text, timestamptz)
  to service_role, postgres;
grant execute on function public.ve_resolve_template_launch(uuid, uuid, uuid, text, jsonb, uuid, uuid, timestamptz)
  to service_role, postgres;
