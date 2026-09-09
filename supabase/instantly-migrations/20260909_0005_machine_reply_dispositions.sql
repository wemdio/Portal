-- Owner-independent technical dispositions. Migration-first rollout is safe;
-- code-first writes/read guards fail closed until this marker is available.
begin;

alter table public.instantly_lead_qualifications
  add column if not exists machine_reply_kind text;

comment on column public.instantly_lead_qualifications.machine_reply_kind is
  'Deterministic complete-inbound machine verdict before ownership resolution. Non-null rows are ownerless technical records: campaign_id is provenance only and must never grant client/project visibility.';

alter table public.instantly_lead_qualifications
  drop constraint if exists instantly_qualification_machine_disposition_check;
alter table public.instantly_lead_qualifications
  add constraint instantly_qualification_machine_disposition_check check (
    machine_reply_kind is null
    or (
      machine_reply_kind in ('auto_reply', 'delivery_failure', 'service_acknowledgement')
      and status = 'not_lead'
      and qualified_project_id is null
      and qualified_project_owner_proven is false
      and proposal_seen is false
      and coalesce(cardinality(interest_signals), 0) = 0
      and instantly_lead_id is null
    )
  );

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
  if tg_op = 'UPDATE' and old.machine_reply_kind is not null then
    if new.machine_reply_kind is distinct from old.machine_reply_kind
       or new.campaign_id is distinct from old.campaign_id
       or new.instantly_email_id is distinct from old.instantly_email_id then
      raise exception using errcode = '23514',
        message = 'qualification_machine_disposition_immutable';
    end if;
  end if;

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

  -- This exception is deliberately before live campaign ownership resolution.
  -- A provider campaign is only provenance for a technical machine message:
  -- do not infer a project and do not forge proven self-serve ownership.
  -- The CHECK constraint enforces the terminal ownerless negative state.
  if new.machine_reply_kind is not null then
    if tg_op = 'UPDATE' and old.machine_reply_kind is null then
      if old.status <> 'processing'
         or old.ai_confidence is distinct from 0
         or old.qualified_project_owner_proven is true
         or old.qualified_project_id is not null
         or not (
           coalesce(old.ai_reason, '') ilike 'Автоматическая повторная квалификация:%'
           or coalesce(old.ai_reason, '') ilike 'Не удалось однозначно определить проект-владельца ответа:%'
         ) then
        raise exception using errcode = '23514',
          message = 'qualification_machine_disposition_requires_unhandled_retry';
      end if;
      -- Do not reopen historical delivery decisions. The worker also checks
      -- the external main-DB notification log immediately before its retry CAS.
      -- Read/action authorization denies the ownerless technical retry cohort
      -- before it can race this transition; these checks are not a lock protocol.
      if exists (select 1 from public.client_forwarded_leads where qualification_id = old.id)
         or exists (select 1 from public.instantly_pending_handoffs where qualification_id = old.id)
         or exists (select 1 from public.instantly_specialist_alert_decisions where qualification_id = old.id)
         or exists (select 1 from public.instantly_lead_handoff_outbox where qualification_id = old.id) then
        raise exception using errcode = '23514',
          message = 'qualification_machine_disposition_delivery_protected';
      end if;
    end if;
    return new;
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
  ai_reason,
  machine_reply_kind,
  instantly_email_id
on public.instantly_lead_qualifications
for each row execute function public.enforce_qualification_project_owner_snapshot();

notify pgrst, 'reload schema';
commit;
