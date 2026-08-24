-- Freeze the project/self-serve owner that is proven when a new reply is
-- qualified. Qualification persistence and every ownership mutation use the
-- same advisory lock, so no terminal verdict can commit across a reassignment.
-- Historical rows deliberately remain NULL/legacy: the current campaign owner
-- is not proof of who owned an old reply when it arrived.

alter table public.instantly_lead_qualifications
  add column if not exists qualified_project_id uuid;

alter table public.instantly_lead_qualifications
  add column if not exists qualified_project_owner_proven boolean;

alter table public.instantly_lead_qualifications
  alter column qualified_project_owner_proven drop not null,
  alter column qualified_project_owner_proven set default false;

comment on column public.instantly_lead_qualifications.qualified_project_id is
  'Immutable managed-project owner proven when this reply qualification was persisted. NULL for proven self-serve, unresolved retry, or legacy history.';

comment on column public.instantly_lead_qualifications.qualified_project_owner_proven is
  'TRUE means atomically proven (UUID project or NULL self-serve); FALSE means retry/review is unresolved; NULL means pre-migration legacy history.';

create index if not exists idx_instantly_lead_qualifications_qualified_project
  on public.instantly_lead_qualifications (qualified_project_id, created_at desc)
  where qualified_project_owner_proven is true
    and qualified_project_id is not null;

create index if not exists idx_instantly_lead_qualifications_unresolved_owner
  on public.instantly_lead_qualifications (campaign_id, updated_at)
  where qualified_project_owner_proven is not true;

-- Extend the existing single-owner guard so changing campaign_id locks both
-- the removed and added ownership keys in stable order. This closes the same
-- none/project race for direct UPDATEs that the claim RPC already closes.
create or replace function public.enforce_instantly_campaign_single_project()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_campaign_id text;
begin
  if tg_op = 'UPDATE' and old.campaign_id is distinct from new.campaign_id then
    for v_campaign_id in
      select campaign_id
      from (values (old.campaign_id), (new.campaign_id)) ids(campaign_id)
      where campaign_id is not null and btrim(campaign_id) <> ''
      group by campaign_id
      order by campaign_id
    loop
      perform pg_advisory_xact_lock(
        hashtextextended('instantly-campaign:' || v_campaign_id, 0)
      );
    end loop;
  else
    perform pg_advisory_xact_lock(
      hashtextextended('instantly-campaign:' || new.campaign_id, 0)
    );
  end if;

  if tg_table_name = 'project_instantly_campaigns' then
    if exists (
      select 1
      from public.project_instantly_campaigns own
      where own.campaign_id = new.campaign_id
        and own.project_id <> new.project_id
        and own.id is distinct from new.id
    ) or exists (
      select 1
      from public.project_period_instantly_campaigns period_own
      where period_own.campaign_id = new.campaign_id
        and period_own.project_id <> new.project_id
    ) then
      raise exception using
        errcode = '23514',
        message = 'campaign_project_ownership_conflict';
    end if;
  else
    if exists (
      select 1
      from public.project_period_instantly_campaigns period_own
      where period_own.campaign_id = new.campaign_id
        and period_own.project_id <> new.project_id
        and period_own.id is distinct from new.id
    ) or exists (
      select 1
      from public.project_instantly_campaigns own
      where own.campaign_id = new.campaign_id
        and own.project_id <> new.project_id
    ) then
      raise exception using
        errcode = '23514',
        message = 'campaign_project_ownership_conflict';
    end if;
  end if;

  return new;
end;
$$;

-- A DELETE removes ownership just as surely as a reassignment. Direct deletes
-- and the period-reservation release RPC therefore serialize with snapshots.
create or replace function public.lock_instantly_campaign_owner_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('instantly-campaign:' || old.campaign_id, 0)
  );
  return old;
end;
$$;

drop trigger if exists trg_project_campaign_owner_delete_lock
  on public.project_instantly_campaigns;
create trigger trg_project_campaign_owner_delete_lock
before delete on public.project_instantly_campaigns
for each row execute function public.lock_instantly_campaign_owner_delete();

drop trigger if exists trg_project_period_campaign_owner_delete_lock
  on public.project_period_instantly_campaigns;
create trigger trg_project_period_campaign_owner_delete_lock
before delete on public.project_period_instantly_campaigns
for each row execute function public.lock_instantly_campaign_owner_delete();

-- The ordinary release path may delete several campaign reservations in one
-- transaction. Pre-lock their keys in deterministic order so two concurrent
-- bulk releases cannot acquire the row-trigger locks in opposite order.
create or replace function public.release_project_period_campaign_reservations(
  p_project_id uuid,
  p_period_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_campaign_id text;
  v_released integer := 0;
begin
  for v_campaign_id in
    select distinct reservation.campaign_id
    from public.project_period_instantly_campaigns reservation
    where reservation.project_id = p_project_id
      and reservation.period_id = any(coalesce(p_period_ids, array[]::uuid[]))
    order by reservation.campaign_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('instantly-campaign:' || v_campaign_id, 0)
    );
  end loop;

  delete from public.project_period_instantly_campaigns reservation
  where reservation.project_id = p_project_id
    and reservation.period_id = any(coalesce(p_period_ids, array[]::uuid[]));
  get diagnostics v_released = row_count;
  return jsonb_build_object('released', v_released);
end;
$$;

create or replace function public.enforce_qualification_project_owner_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner_count integer := 0;
  v_owner_project_ids uuid[] := array[]::uuid[];
  v_is_generated_retry boolean := false;
begin
  if tg_op = 'UPDATE' and old.qualified_project_owner_proven is true then
    if new.qualified_project_owner_proven is not true
       or new.qualified_project_id is distinct from old.qualified_project_id
       or new.campaign_id is distinct from old.campaign_id then
      raise exception using
        errcode = '23514',
        message = 'qualification_project_snapshot_immutable';
    end if;

    -- A proven snapshot is a historical fact. Status/reason edits must remain
    -- possible for its original project even after the live campaign moves.
    return new;
  end if;

  if new.campaign_id is null or btrim(new.campaign_id) = '' then
    raise exception using
      errcode = '22023',
      message = 'qualification_campaign_id_required';
  end if;

  -- claim_project_instantly_campaign, period reservations and both ownership
  -- table triggers use this exact key. Whichever transaction wins establishes
  -- one coherent order for project, self-serve and unresolved states.
  perform pg_advisory_xact_lock(
    hashtextextended('instantly-campaign:' || new.campaign_id, 0)
  );

  select
    count(distinct owner.project_id)::integer,
    coalesce(array_agg(distinct owner.project_id), array[]::uuid[])
  into v_owner_count, v_owner_project_ids
  from (
    select project_id
    from public.project_instantly_campaigns
    where campaign_id = new.campaign_id
    union all
    select project_id
    from public.project_period_instantly_campaigns
    where campaign_id = new.campaign_id
  ) owner;

  if new.qualified_project_owner_proven is true then
    if new.qualified_project_id is null then
      if v_owner_count <> 0 then
        raise exception using
          errcode = '40001',
          message = 'qualification_self_serve_ownership_changed';
      end if;
    elsif v_owner_count <> 1
      or not (new.qualified_project_id = any(v_owner_project_ids))
    then
      raise exception using
        errcode = '40001',
        message = 'qualification_project_ownership_changed';
    end if;
    return new;
  end if;

  if new.qualified_project_id is not null then
    raise exception using
      errcode = '23514',
      message = 'qualification_project_snapshot_state_invalid';
  end if;

  v_is_generated_retry :=
    new.status in ('pending', 'processing', 'needs_review', 'error')
    and (
      coalesce(new.ai_reason, '') ilike 'Автоматическая повторная квалификация:%'
      or coalesce(new.ai_reason, '') ilike 'Не удалось однозначно определить проект-владельца ответа:%'
    );

  -- Compatibility for a migration-first rollout:
  -- * an old worker can still prove a self-serve row atomically;
  -- * review/retry rows remain side-effect free and can be resumed by the new worker;
  -- * a terminal managed verdict is rejected before board/Telegram/handoff.
  if v_is_generated_retry then
    return new;
  end if;

  -- Pending/processing rows have not reached a verdict and must stay mutable.
  if new.status in ('pending', 'processing') then
    return new;
  end if;

  if v_owner_count = 0 then
    new.qualified_project_owner_proven := true;
    return new;
  end if;

  if v_owner_count = 1 and new.status in ('needs_review', 'error') then
    new.qualified_project_id := v_owner_project_ids[1];
    new.qualified_project_owner_proven := true;
    return new;
  end if;

  if v_owner_count > 1 and new.status in ('needs_review', 'error') then
    return new;
  end if;

  raise exception using
    errcode = '40001',
    -- Old workers recognize 503 as retryable and persist a generated
    -- needs_review row; new workers recognize the stable prefix/code.
    message = 'qualification_project_snapshot_required: retryable 503';
end;
$$;

drop trigger if exists trg_qualification_project_owner_snapshot
  on public.instantly_lead_qualifications;
create trigger trg_qualification_project_owner_snapshot
before insert or update of
  campaign_id,
  qualified_project_id,
  qualified_project_owner_proven,
  status,
  ai_reason
on public.instantly_lead_qualifications
for each row execute function public.enforce_qualification_project_owner_snapshot();
