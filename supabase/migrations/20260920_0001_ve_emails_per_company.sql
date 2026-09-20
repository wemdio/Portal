-- VE2: specialist-set limit "addresses per company taken into work".
-- NULL = no limit = behaviour before this migration: every existing setup, base,
-- approval revision and launched plan stays byte-identical. The constructor
-- still keeps every validated address; the limit only decides which of them
-- form the ready base, the rest stays in the reserve.
alter table public.ve_outreach_setups add column if not exists max_emails_per_company integer;
alter table public.ve_bases add column if not exists max_emails_per_company integer;
-- What the worker's last partition of this base actually applied; NULL = none.
alter table public.ve_bases add column if not exists contact_cap_applied integer;

alter table public.ve_outreach_setups drop constraint if exists ve_outreach_setups_max_emails_per_company_check;
alter table public.ve_outreach_setups add constraint ve_outreach_setups_max_emails_per_company_check
  check (max_emails_per_company is null or max_emails_per_company between 1 and 100);
alter table public.ve_bases drop constraint if exists ve_bases_max_emails_per_company_check;
alter table public.ve_bases add constraint ve_bases_max_emails_per_company_check
  check (max_emails_per_company is null or max_emails_per_company between 1 and 100);

comment on column public.ve_outreach_setups.max_emails_per_company is
  'VE2: сколько адресов одной компании брать в работу (NULL = без ограничения). Задаёт специалист.';
comment on column public.ve_bases.max_emails_per_company is
  'VE2: действующий для этой базы лимит адресов на компанию. Не меняется после утверждения/запуска базы.';
comment on column public.ve_bases.contact_cap_applied is
  'VE2: лимит, применённый воркером при последнем разбиении базы на готовые контакты и резерв.';

-- A base whose audience must never change any more (same rule as VE_REVIEW_APPROVED).
create or replace function public.ve_base_audience_frozen(p_base_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.ve_templates t where t.base_id=p_base_id and t.launch_info is not null)
    or exists(select 1 from public.ve_contact_supply_plans p join public.ve_templates t on t.id=p.template_id where t.base_id=p_base_id)
    or exists(select 1 from public.ve_launch_queue_items q where q.base_id=p_base_id)
    or exists(select 1 from public.ve_segmentation_audits a where a.base_id=p_base_id and a.launch_status <> 'idle');
$$;

create or replace function public.ve_save_outreach_contact_limit(
  p_project_id uuid, p_revision bigint, p_max integer, p_actor uuid
) returns public.ve_outreach_setups language plpgsql security definer set search_path = '' as $$
declare v_setup public.ve_outreach_setups;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 22082029));
  if p_project_id is null or p_revision is null or p_revision<1 or p_actor is null then raise exception 'Некорректный запрос'; end if;
  if p_max is not null and (p_max<1 or p_max>100) then raise exception 'Укажите целое число от 1 до 100 или оставьте поле пустым'; end if;
  if not exists (select 1 from public.ve_projects where id=p_project_id) then raise exception 'Проект не найден'; end if;
  insert into public.ve_outreach_setups(project_id) values(p_project_id) on conflict do nothing;
  select * into v_setup from public.ve_outreach_setups where project_id=p_project_id for update;
  if v_setup.revision<>p_revision then raise exception 'Выбор изменился. Обновите страницу'; end if;
  update public.ve_outreach_setups set max_emails_per_company=p_max,
    revision=revision+1, updated_at=now(), updated_by=p_actor where project_id=p_project_id returning * into v_setup;
  -- Plain-column update on a handful of rows: the multi-megabyte data/collect_info
  -- values are not read or rewritten. Launched/planned audiences keep their own
  -- value, so what a client already receives never changes under them.
  update public.ve_bases b set max_emails_per_company=p_max
    where b.project_id=p_project_id and b.source='auto' and b.hypothesis_id is not null
      and b.max_emails_per_company is distinct from p_max
      -- A daily supply batch belongs to a launched campaign and re-reads the
      -- project setting when it collects; stamping it would only leave a row
      -- the re-projection can never serve.
      and not exists(select 1 from public.ve_contact_supply_batches x where x.base_id=b.id)
      and not public.ve_base_audience_frozen(b.id);
  return v_setup;
end $$;

-- Apply a TIGHTENED limit to an already finished preview without any paid work:
-- the worker re-partitions the saved ready rows (payload reproject_contacts) and
-- moves the addresses over the limit into the reserve. Raising or removing the
-- limit is NOT automatic: returning addresses need a company-name check, so that
-- path stays behind the specialist's explicit «Продолжить подготовку».
-- The base status is NOT changed here: a failed job must never leave a finished
-- base looking like an interrupted collection.
create or replace function public.ve_enqueue_contact_reprojection(p_base_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b record;
  j public.ve_jobs%rowtype;
  v_project uuid;
begin
  -- Same lock order as every other VE2 project RPC (preparation, approval,
  -- outreach start): the project advisory lock BEFORE any row lock on ve_bases.
  select project_id into v_project from public.ve_bases where id=p_base_id;
  if v_project is null then raise exception 'VE_REPROJECT_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_project::text, 22082029));
  -- One read of the large document: every `collect_info -> key` would detoast it again.
  select x.id, x.project_id, x.vertical_id, x.hypothesis_id, x.source, x.status,
      x.max_emails_per_company, x.contact_cap_applied,
      (select jsonb_object_agg(e.key, e.value) from jsonb_each(x.collect_info) e
        where e.key in ('collection_mode','refill','supply_batch_id','target_progress')) as ci
    into b from public.ve_bases x where x.id=p_base_id for update;
  if not found then raise exception 'VE_REPROJECT_NOT_FOUND'; end if;
  if b.source <> 'auto' or b.hypothesis_id is null
    or b.ci->>'collection_mode' is distinct from 'preview'
    or coalesce(b.ci->>'refill','false') <> 'false'
    or b.ci->>'supply_batch_id' is not null
    or b.ci->'target_progress' is null then
    -- Permanent: record it so this base leaves the sweep's candidate set instead
    -- of being probed (and detoasted) every two minutes forever.
    update public.ve_bases set contact_cap_applied=b.max_emails_per_company where id=b.id;
    return jsonb_build_object('ok',true,'skipped','unsupported','base_id',b.id);
  end if;
  if b.max_emails_per_company is not distinct from b.contact_cap_applied then
    return jsonb_build_object('ok',true,'skipped','unchanged','base_id',b.id);
  end if;
  -- Only a tightening is applied automatically (first limit, or a smaller one).
  if b.max_emails_per_company is null
    or (b.contact_cap_applied is not null and b.max_emails_per_company > b.contact_cap_applied) then
    return jsonb_build_object('ok',true,'skipped','needs_manual_continue','base_id',b.id);
  end if;
  if public.ve_base_audience_frozen(b.id) then
    -- The audience of a launched or planned base is final; nothing will re-apply
    -- the limit to it, so it must not stay in the sweep's candidate set.
    update public.ve_bases set contact_cap_applied=b.max_emails_per_company where id=b.id;
    return jsonb_build_object('ok',true,'skipped','frozen','base_id',b.id);
  end if;
  -- Only this base's own collection round re-partitions it; a pending template,
  -- base_analyze or segmentation_audit job does not, so it must not look like
  -- "the limit will be applied anyway". Those states are retried by the sweep.
  select * into j from public.ve_jobs where project_id=b.project_id
    and payload->>'base_id'=b.id::text and status in ('pending','running')
    order by created_at desc limit 1;
  if found then
    return jsonb_build_object('ok',true,'skipped',
      case when j.stage='base_collect' then 'collect_in_flight' else 'base_busy' end,
      'job_id',j.id,'base_id',b.id);
  end if;
  if b.status <> 'analyzed' then
    return jsonb_build_object('ok',true,'skipped','base_'||b.status,'base_id',b.id);
  end if;
  begin
    insert into public.ve_jobs(project_id,stage,status,payload)
      values(b.project_id,'base_collect','pending',jsonb_build_object('base_id',b.id,
        'vertical_id',b.vertical_id,'hypothesis_id',b.hypothesis_id,'collection_mode','preview',
        'ready_target',coalesce((b.ci->'target_progress'->>'ready_target')::int,500),'reproject_contacts',true)) returning * into j;
  exception when others then
    -- A stopped preparation (ve_outreach_preparation_cancel_guard) or a race with
    -- another enqueue must not abort the caller's transaction: the mismatch stays
    -- on the row and the sweep tries again.
    return jsonb_build_object('ok',false,'skipped','insert_refused','reason',left(sqlerrm,200),'base_id',b.id);
  end;
  return jsonb_build_object('ok',true,'queued',true,'job_id',j.id,'base_id',b.id);
end $$;

-- Cheap candidate scan for the worker sweep: plain columns only, so the
-- multi-megabyte collect_info of every base is never detoasted. The per-base
-- RPC above re-checks everything before it enqueues anything.
create or replace function public.ve_pending_contact_reprojections(p_limit integer default 25)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select b.id from public.ve_bases b
  where b.source='auto' and b.status='analyzed' and b.hypothesis_id is not null
    and b.max_emails_per_company is not null
    and (b.contact_cap_applied is null or b.contact_cap_applied > b.max_emails_per_company)
    and not exists(select 1 from public.ve_contact_supply_batches x where x.base_id=b.id)
    and not public.ve_base_audience_frozen(b.id)
  order by b.updated_at desc
  limit greatest(1, least(coalesce(p_limit,25), 100));
$$;

revoke all on function public.ve_base_audience_frozen(uuid), public.ve_save_outreach_contact_limit(uuid,bigint,integer,uuid),
  public.ve_enqueue_contact_reprojection(uuid), public.ve_pending_contact_reprojections(integer) from public, anon, authenticated;
grant execute on function public.ve_base_audience_frozen(uuid), public.ve_save_outreach_contact_limit(uuid,bigint,integer,uuid),
  public.ve_enqueue_contact_reprojection(uuid), public.ve_pending_contact_reprojections(integer) to service_role;
