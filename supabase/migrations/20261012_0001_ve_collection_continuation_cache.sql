-- Cache only the server's pure continuation decision. Polling the project must
-- not load collect_info (which can contain hundreds of MB of saved candidates).
-- Old bases deliberately remain unchecked until one explicit preflight reads
-- their full state. No backfill, jobs, paid checks or timestamps are changed.
alter table public.ve_bases
  add column if not exists collection_continuation jsonb,
  add column if not exists collection_continuation_revision bigint not null default 0;

comment on column public.ve_bases.collection_continuation is
  'VE2: versioned TS continuation verdict and scalar basis; NULL/stale means an explicit state check is needed. Never an authorization to enqueue by itself.';
comment on column public.ve_bases.collection_continuation_revision is
  'VE2: CAS revision for continuation eligibility; advances even when a legacy writer does not update updated_at.';

create or replace function public.ve_base_continuation_invalidate()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.collection_continuation := null;
  new.collection_continuation_revision := old.collection_continuation_revision + 1;
  return new;
end $$;

-- UPDATE OF is a syntactic check: never compare/detoast the old and new JSON.
-- A cache-only write skips this trigger and the existing public_info trigger.
drop trigger if exists ve_bases_continuation_invalidate on public.ve_bases;
create trigger ve_bases_continuation_invalidate
  before update of collect_info, status, error, max_emails_per_company,
    contact_cap_applied, source, hypothesis_id, project_id on public.ve_bases
  for each row execute function public.ve_base_continuation_invalidate();

revoke all on function public.ve_base_continuation_invalidate() from public, anon, authenticated;
grant execute on function public.ve_base_continuation_invalidate() to service_role;

-- An explicit, preflighted request must leave durable retry intent for an
-- orphaned collection/analysis or failed letters as well as a partial preview.
-- The coordinator and enqueue recheck eligibility and preserve paid checkpoints.
-- Do not overwrite a live lease/job or reopen an already launched base.
alter table public.ve_outreach_preparations
  add column if not exists resume_collection_requested boolean not null default false;
-- Consume collection consent once a durable job exists or the request has
-- finished. A later bulk preparation/recovery must not inherit old consent.
create or replace function public.ve_preparation_consume_collection_intent()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status <> 'pending' then new.resume_collection_requested := false; end if;
  return new;
end $$;
drop trigger if exists ve_preparation_consume_collection_intent on public.ve_outreach_preparations;
create trigger ve_preparation_consume_collection_intent
  before update of status on public.ve_outreach_preparations
  for each row execute function public.ve_preparation_consume_collection_intent();
revoke all on function public.ve_preparation_consume_collection_intent() from public,anon,authenticated;
grant execute on function public.ve_preparation_consume_collection_intent() to service_role;
-- Keep a single RPC signature; old three-argument recovery calls use the safe
-- default (finish preparation, never reopen an analyzed partial preview).
drop function if exists public.ve_request_outreach_hypothesis_preparation(uuid,bigint,uuid);
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
  if p_hypothesis_id is null or not (p_hypothesis_id=any(v_setup.selected_hypothesis_ids))
    or not exists(select 1 from public.ve_hypotheses h where h.id=p_hypothesis_id
      and h.project_id=p_project_id and h.vertical_id is not null and h.status is distinct from 'rejected') then
    raise exception 'Выберите доступную гипотезу этого проекта';
  end if;
  if exists(select 1 from public.ve_outreach_preparations p where p.project_id=p_project_id
    and p.hypothesis_id=p_hypothesis_id and p.language<>v_setup.language
    and (p.base_id is not null or p.template_id is not null or p.status<>'pending' or p.locked_until>clock_timestamp())) then
    raise exception 'Язык сохранённой подготовки не совпадает с выбором. Верните прежний язык.';
  end if;
  insert into public.ve_outreach_preparations as prep(project_id,hypothesis_id,language,resume_collection_requested)
    values(p_project_id,p_hypothesis_id,v_setup.language,coalesce(p_resume_collection,false))
    on conflict(project_id,hypothesis_id) do update set
      status='pending', language=excluded.language, last_error=null, cancelled_at=null,
      locked_until=null, claim_token=null, updated_at=clock_timestamp(),
      resume_collection_requested=excluded.resume_collection_requested
    where (prep.locked_until is null or prep.locked_until<=clock_timestamp())
      and not exists(select 1 from public.ve_jobs j
        where j.project_id=prep.project_id and j.payload->>'base_id'=prep.base_id::text
          and j.stage in ('base_collect','base_analyze','template','base_reproject_contacts')
          and j.status in ('pending','running'))
      and not exists(select 1 from public.ve_templates t
        where t.base_id=prep.base_id and t.launch_info is not null);
end $$;
revoke all on function public.ve_request_outreach_hypothesis_preparation(uuid,bigint,uuid,boolean) from public,anon,authenticated;
grant execute on function public.ve_request_outreach_hypothesis_preparation(uuid,bigint,uuid,boolean) to service_role;
