-- Vertical Engine v2 launch portfolio: paused preparation, mailbox-scoped
-- activation capacity and fail-closed reconciliation.

create table if not exists public.ve_launch_portfolio_settings (
  id                     text primary key,
  market                 text not null unique,
  timezone               text not null,
  mode                   text not null default 'advisory'
    check (mode in ('advisory','enforced')),
  max_active_bundles     integer not null default 1
    check (max_active_bundles > 0),
  default_slot_days      numeric(8,2) not null default 14
    check (default_slot_days > 0),
  capacity_calendar      jsonb not null default '[]'::jsonb
    check (jsonb_typeof(capacity_calendar) = 'array'),
  plan_version           bigint not null default 1
    check (plan_version > 0),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

insert into public.ve_launch_portfolio_settings(id, market, timezone, mode)
values
  ('ru', 'ru', 'Europe/Moscow', 'enforced'),
  ('us', 'us', 'UTC', 'advisory')
on conflict (id) do update
  set market = excluded.market,
      timezone = excluded.timezone,
      mode = excluded.mode,
      updated_at = now();

create table if not exists public.ve_launch_queue_items (
  id                         uuid primary key default gen_random_uuid(),
  portfolio_id               text not null references public.ve_launch_portfolio_settings(id),
  project_id                 uuid not null references public.ve_projects(id) on delete cascade,
  vertical_id                uuid not null references public.ve_verticals(id) on delete cascade,
  hypothesis_id              uuid references public.ve_hypotheses(id) on delete set null,
  base_id                    uuid not null references public.ve_bases(id) on delete cascade,
  template_id                uuid not null references public.ve_templates(id) on delete cascade,
  segmentation_audit_id      uuid not null references public.ve_segmentation_audits(id) on delete cascade,
  prepare_reservation_id     uuid not null unique,
  preset_id                  text not null,
  instantly_account_id       text not null,
  mailbox_ids                text[] not null,
  status                     text not null default 'prepared'
    check (status in (
      'prepared','queued','activating','active','uncertain','released','skipped','cancelled'
    )),
  manual_order               integer,
  not_before                 timestamptz,
  latest_activation_at       timestamptz,
  seasonality_confidence     text
    check (seasonality_confidence is null or seasonality_confidence in ('low','medium','high')),
  seasonality_input_hash     text
    check (seasonality_input_hash is null or seasonality_input_hash ~ '^[0-9a-f]{64}$'),
  seasonality_snapshot       jsonb not null default '{}'::jsonb
    check (jsonb_typeof(seasonality_snapshot) = 'object'),
  potential_pct              numeric(5,2) not null default 0,
  estimated_run_days         numeric(8,2),
  priority_snapshot          jsonb not null default '{}'::jsonb
    check (jsonb_typeof(priority_snapshot) = 'object'),
  plan_version               bigint not null default 1,
  activation_reservation_id  uuid,
  activation_idempotency_key uuid,
  activation_started_by      uuid,
  activation_started_at      timestamptz,
  activation_error           text,
  ever_active_at             timestamptz,
  released_at                timestamptz,
  released_by                uuid,
  release_reason             text,
  priority_override_reason   text,
  priority_override_decision text
    check (
      priority_override_decision is null
      or priority_override_decision in ('activate_next','wait')
    ),
  priority_overridden_by     uuid,
  priority_overridden_at     timestamptz,
  prepared_at                timestamptz not null default now(),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  check (cardinality(mailbox_ids) > 0),
  check (estimated_run_days is null or estimated_run_days > 0),
  check (plan_version > 0)
);

create unique index if not exists ve_launch_queue_items_activation_idempotency
  on public.ve_launch_queue_items(activation_idempotency_key)
  where activation_idempotency_key is not null;

create index if not exists idx_ve_launch_queue_items_order
  on public.ve_launch_queue_items(
    portfolio_id,
    status,
    manual_order,
    latest_activation_at,
    seasonality_confidence,
    potential_pct,
    created_at
  );

create index if not exists idx_ve_launch_queue_items_workspace
  on public.ve_launch_queue_items(instantly_account_id, status);

create index if not exists idx_ve_launch_queue_items_mailboxes
  on public.ve_launch_queue_items using gin(mailbox_ids);

create table if not exists public.ve_launch_queue_campaigns (
  id                     uuid primary key default gen_random_uuid(),
  item_id                uuid not null references public.ve_launch_queue_items(id) on delete cascade,
  instantly_account_id   text not null,
  campaign_id            text not null,
  campaign_name          text,
  campaign_url           text,
  segment                text,
  leads_count            integer not null default 0 check (leads_count >= 0),
  remote_status          integer,
  status_observed_at     timestamptz,
  activated_at           timestamptz,
  completed_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (instantly_account_id, campaign_id),
  unique (item_id, campaign_id)
);

create index if not exists idx_ve_launch_queue_campaigns_item
  on public.ve_launch_queue_campaigns(item_id);

-- Clustering/base reruns delete their old v2 graph with FK cascades. Never let
-- that housekeeping erase an Instantly ledger that owns a tracked campaign.
-- Cached remote status is not deletion proof: a Completed campaign can be
-- reactivated outside Portal after the last observation. Cleanup therefore
-- needs a future explicit remote-delete workflow; source cascades are allowed
-- only for childless placeholders.
create or replace function public.ve_guard_launch_queue_item_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status in ('prepared','queued','activating','active','uncertain') then
    raise exception using
      errcode = '55000',
      message = format(
        'launch bundle % is % and is not remotely terminal',
        old.id,
        old.status
      );
  end if;

  if exists (
    select 1
      from public.ve_launch_queue_campaigns c
     where c.item_id = old.id
  ) then
    raise exception using
      errcode = '55000',
      message = format(
        'launch bundle % still owns tracked remote campaign records',
        old.id
      );
  end if;
  return old;
end;
$$;

drop trigger if exists ve_launch_queue_items_guard_delete
  on public.ve_launch_queue_items;
create trigger ve_launch_queue_items_guard_delete
before delete on public.ve_launch_queue_items
for each row execute function public.ve_guard_launch_queue_item_delete();

alter table public.ve_launch_portfolio_settings enable row level security;
alter table public.ve_launch_queue_items enable row level security;
alter table public.ve_launch_queue_campaigns enable row level security;

revoke all on public.ve_launch_portfolio_settings from public, anon, authenticated;
revoke all on public.ve_launch_queue_items from public, anon, authenticated;
revoke all on public.ve_launch_queue_campaigns from public, anon, authenticated;

grant all on public.ve_launch_portfolio_settings to service_role, postgres;
grant all on public.ve_launch_queue_items to service_role, postgres;
grant all on public.ve_launch_queue_campaigns to service_role, postgres;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.ve_launch_portfolio_settings, public.ve_launch_queue_items, public.ve_launch_queue_campaigns to readonly';
  end if;
end;
$$;

-- Preserve the existing signature. A successful paused preparation now writes
-- the template, audit terminal state, immutable bundle and all campaign
-- children in one transaction. Failed/uncertain preparation never creates an
-- activatable queue item.
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
  v_existing_audit public.ve_segmentation_audits%rowtype;
  v_item public.ve_launch_queue_items%rowtype;
  v_project_id uuid;
  v_vertical_id uuid;
  v_hypothesis_id uuid;
  v_base_id uuid;
  v_market text;
  v_account_id text;
  v_preset_id text;
  v_mailbox_json jsonb;
  v_mailbox_ids text[];
  v_campaigns jsonb;
  v_campaign jsonb;
  v_campaign_id text;
  v_remote_status integer;
  v_status_observed_at timestamptz;
  v_seen_campaign_ids text[] := '{}'::text[];
  v_seasonality jsonb;
  v_seasonality_hash text;
  v_latest_activation_at timestamptz;
  v_confidence text;
  v_potential_pct numeric(5,2);
  v_estimated_run_days numeric(8,2);
  v_manual_order integer;
  v_plan_version bigint;
begin
  if p_audit_id is null or p_template_id is null or p_launch_reservation_id is null
     or p_now is null then
    raise exception 'audit, template, reservation and timestamp are required';
  end if;
  if p_launch_status is null or p_launch_status not in ('succeeded','failed','uncertain') then
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
    select a.*
      into v_existing_audit
      from public.ve_segmentation_audits a
     where a.id = p_audit_id
       and a.template_id = p_template_id
       and a.launch_reservation_id = p_launch_reservation_id;

    if found and v_existing_audit.launch_status = p_launch_status then
      select q.*
        into v_item
        from public.ve_launch_queue_items q
       where q.prepare_reservation_id = p_launch_reservation_id;
      return jsonb_build_object(
        'finalized', true,
        'replayed', true,
        'audit_row', to_jsonb(v_existing_audit),
        'launch_info', p_launch_info,
        'queue_item', case when v_item.id is null then null else to_jsonb(v_item) end
      );
    end if;
    return jsonb_build_object('finalized', false, 'replayed', false);
  end if;

  if p_launch_info is not null then
    update public.ve_templates
       set launch_info = p_launch_info
     where id = p_template_id;
    if not found then
      raise exception 'template % not found', p_template_id;
    end if;
  end if;

  if p_launch_status = 'succeeded' then
    v_account_id := nullif(btrim(p_launch_info ->> 'instantly_account_id'), '');
    v_preset_id := nullif(btrim(p_launch_info ->> 'preset_id'), '');
    if v_account_id is null then
      raise exception 'succeeded launch requires instantly_account_id snapshot';
    end if;
    if v_preset_id is null then
      raise exception 'succeeded launch requires preset_id';
    end if;

    v_mailbox_json := coalesce(
      p_launch_info -> 'mailbox_ids',
      p_launch_info -> 'email_account_ids',
      '[]'::jsonb
    );
    if jsonb_typeof(v_mailbox_json) <> 'array' then
      raise exception 'mailbox_ids must be an array';
    end if;
    select coalesce(array_agg(m.mailbox_id order by m.mailbox_id), '{}'::text[])
      into v_mailbox_ids
      from (
        select distinct lower(btrim(value)) as mailbox_id
          from jsonb_array_elements_text(v_mailbox_json)
         where btrim(value) <> ''
      ) m;
    if cardinality(v_mailbox_ids) = 0 then
      raise exception 'succeeded launch requires a non-empty mailbox_ids snapshot';
    end if;

    if jsonb_typeof(p_launch_info -> 'campaigns') = 'array'
       and jsonb_array_length(p_launch_info -> 'campaigns') > 0 then
      v_campaigns := p_launch_info -> 'campaigns';
    elsif nullif(btrim(p_launch_info ->> 'campaign_id'), '') is not null then
      v_campaigns := jsonb_build_array(jsonb_build_object(
        'campaign_id', p_launch_info ->> 'campaign_id',
        'campaign_name', p_launch_info ->> 'campaign_name',
        'campaign_url', p_launch_info ->> 'campaign_url',
        'segment', null,
        'leads_count', coalesce(p_launch_info -> 'leads_count', '0'::jsonb)
      ));
    else
      raise exception 'succeeded launch requires at least one campaign';
    end if;

    select
      b.project_id,
      t.vertical_id,
      b.hypothesis_id,
      b.id,
      coalesce(p.market, 'ru'),
      coalesce(v.potential_pct, 0)
      into
        v_project_id,
        v_vertical_id,
        v_hypothesis_id,
        v_base_id,
        v_market,
        v_potential_pct
      from public.ve_templates t
      join public.ve_bases b on b.id = t.base_id
      join public.ve_projects p on p.id = b.project_id
      left join public.ve_verticals v on v.id = t.vertical_id
     where t.id = p_template_id;
    if not found then
      raise exception 'template % identity not found', p_template_id;
    end if;
    if v_project_id <> v_audit.project_id or v_base_id <> v_audit.base_id then
      raise exception 'launch identity does not match audit snapshot';
    end if;

    select s.plan_version
      into v_plan_version
      from public.ve_launch_portfolio_settings s
     where s.id = v_market
     for share;
    if not found then
      raise exception 'launch portfolio % is not configured', v_market;
    end if;

    v_seasonality := coalesce(p_launch_info -> 'seasonality', '{}'::jsonb);
    if jsonb_typeof(v_seasonality) <> 'object' then
      raise exception 'seasonality snapshot must be an object';
    end if;
    v_seasonality_hash := nullif(lower(btrim(coalesce(
      p_launch_info ->> 'seasonality_input_hash',
      v_seasonality ->> 'input_hash'
    ))), '');
    if v_seasonality_hash is not null and v_seasonality_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'seasonality_input_hash must be 64-char lowercase hex';
    end if;

    if nullif(btrim(coalesce(
      p_launch_info ->> 'latest_activation_at',
      v_seasonality ->> 'planned_activation_date'
    )), '') is not null then
      v_latest_activation_at := coalesce(
        p_launch_info ->> 'latest_activation_at',
        v_seasonality ->> 'planned_activation_date'
      )::timestamptz;
    end if;
    v_confidence := nullif(lower(btrim(coalesce(
      p_launch_info ->> 'seasonality_confidence',
      v_seasonality ->> 'confidence'
    ))), '');
    if v_confidence is not null and v_confidence not in ('low','medium','high') then
      v_confidence := null;
    end if;

    if jsonb_typeof(p_launch_info -> 'potential_pct') = 'number' then
      v_potential_pct := (p_launch_info ->> 'potential_pct')::numeric(5,2);
    end if;
    if jsonb_typeof(p_launch_info -> 'estimated_run_days') = 'number' then
      v_estimated_run_days := (p_launch_info ->> 'estimated_run_days')::numeric(8,2);
    end if;
    if jsonb_typeof(p_launch_info -> 'manual_order') = 'number' then
      v_manual_order := (p_launch_info ->> 'manual_order')::integer;
    end if;

    insert into public.ve_launch_queue_items(
      portfolio_id,
      project_id,
      vertical_id,
      hypothesis_id,
      base_id,
      template_id,
      segmentation_audit_id,
      prepare_reservation_id,
      preset_id,
      instantly_account_id,
      mailbox_ids,
      status,
      manual_order,
      latest_activation_at,
      seasonality_confidence,
      seasonality_input_hash,
      seasonality_snapshot,
      potential_pct,
      estimated_run_days,
      priority_snapshot,
      plan_version,
      prepared_at,
      created_at,
      updated_at
    )
    values (
      v_market,
      v_project_id,
      v_vertical_id,
      v_hypothesis_id,
      v_base_id,
      p_template_id,
      p_audit_id,
      p_launch_reservation_id,
      v_preset_id,
      v_account_id,
      v_mailbox_ids,
      'queued',
      v_manual_order,
      v_latest_activation_at,
      v_confidence,
      v_seasonality_hash,
      v_seasonality,
      v_potential_pct,
      v_estimated_run_days,
      coalesce(p_launch_info -> 'priority_snapshot', '{}'::jsonb),
      v_plan_version,
      p_now,
      p_now,
      p_now
    )
    on conflict (prepare_reservation_id) do nothing;

    select q.*
      into v_item
      from public.ve_launch_queue_items q
     where q.prepare_reservation_id = p_launch_reservation_id
     for update;
    if not found then
      raise exception 'failed to persist launch queue item';
    end if;
    if v_item.project_id <> v_project_id
       or v_item.template_id <> p_template_id
       or v_item.segmentation_audit_id <> p_audit_id
       or v_item.instantly_account_id <> v_account_id
       or v_item.mailbox_ids is distinct from v_mailbox_ids then
      raise exception 'prepare reservation already belongs to a different immutable bundle';
    end if;

    for v_campaign in
      select value from jsonb_array_elements(v_campaigns)
    loop
      if jsonb_typeof(v_campaign) <> 'object' then
        raise exception 'campaign snapshot must be an object';
      end if;
      v_campaign_id := nullif(btrim(v_campaign ->> 'campaign_id'), '');
      if v_campaign_id is null then
        raise exception 'campaign snapshot requires campaign_id';
      end if;
      if v_campaign_id = any(v_seen_campaign_ids) then
        raise exception 'duplicate campaign_id in launch snapshot: %', v_campaign_id;
      end if;
      v_seen_campaign_ids := array_append(v_seen_campaign_ids, v_campaign_id);

      v_remote_status := null;
      v_status_observed_at := null;
      if v_campaign ? 'remote_status' or v_campaign ? 'status_observed_at' then
        if not (v_campaign ? 'remote_status')
           or not (v_campaign ? 'status_observed_at')
           or jsonb_typeof(v_campaign -> 'remote_status') is distinct from 'number'
           or jsonb_typeof(v_campaign -> 'status_observed_at') is distinct from 'string'
           or nullif(btrim(v_campaign ->> 'status_observed_at'), '') is null then
          raise exception 'campaign live proof requires remote_status and status_observed_at';
        end if;
        v_remote_status := (v_campaign ->> 'remote_status')::integer;
        v_status_observed_at := (v_campaign ->> 'status_observed_at')::timestamptz;
        if v_remote_status not in (2, 3) then
          raise exception 'recovered campaign % is not proven non-sending', v_campaign_id;
        end if;
      end if;

      insert into public.ve_launch_queue_campaigns(
        item_id,
        instantly_account_id,
        campaign_id,
        campaign_name,
        campaign_url,
        segment,
        leads_count,
        remote_status,
        status_observed_at,
        created_at,
        updated_at
      )
      values (
        v_item.id,
        v_account_id,
        v_campaign_id,
        nullif(v_campaign ->> 'campaign_name', ''),
        nullif(v_campaign ->> 'campaign_url', ''),
        nullif(v_campaign ->> 'segment', ''),
        case
          when jsonb_typeof(v_campaign -> 'leads_count') = 'number'
            then greatest(0, (v_campaign ->> 'leads_count')::integer)
          else 0
        end,
        v_remote_status,
        v_status_observed_at,
        p_now,
        p_now
      )
      on conflict (instantly_account_id, campaign_id) do nothing;

      if not found and not exists (
        select 1
          from public.ve_launch_queue_campaigns c
         where c.instantly_account_id = v_account_id
           and c.campaign_id = v_campaign_id
           and c.item_id = v_item.id
      ) then
        raise exception 'campaign % already belongs to another bundle', v_campaign_id;
      end if;
    end loop;

    -- Recovery may prove that every supplied campaign is already Completed.
    -- Persist that bundle as terminal immediately so it can never be offered
    -- for activation again between finalize and the next live reconciliation.
    if cardinality(v_seen_campaign_ids) > 0 and not exists (
      select 1
        from public.ve_launch_queue_campaigns c
       where c.item_id = v_item.id
         and (
           c.remote_status is distinct from 3
           or c.status_observed_at is null
         )
    ) then
      update public.ve_launch_queue_items
         set status = 'released',
             ever_active_at = coalesce(ever_active_at, p_now),
             released_at = coalesce(released_at, p_now),
             release_reason = coalesce(release_reason, 'Все восстановленные кампании уже завершены'),
             updated_at = p_now
       where id = v_item.id
         and status = 'queued'
       returning * into v_item;
    end if;
  end if;

  update public.ve_segmentation_audits
     set launch_status = p_launch_status,
         launch_error = nullif(left(coalesce(p_error, ''), 500), ''),
         launch_heartbeat_at = p_now,
         launch_completed_at = p_now,
         updated_at = p_now
   where id = p_audit_id
     and launch_reservation_id = p_launch_reservation_id
     and launch_status = 'running'
   returning * into v_audit;
  if not found then
    raise exception 'launch reservation changed before finalize';
  end if;

  return jsonb_build_object(
    'finalized', true,
    'replayed', false,
    'audit_row', to_jsonb(v_audit),
    'launch_info', p_launch_info,
    'queue_item', case when v_item.id is null then null else to_jsonb(v_item) end
  );
end;
$$;

-- Recovery shares the exact successful-finalize path above. The temporary
-- uncertain -> running transition is transaction-local: any snapshot/queue
-- validation error rolls the audit back to its fail-closed uncertain state.
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
  v_finalize jsonb;
begin
  if p_audit_id is null or p_template_id is null or p_launch_reservation_id is null
     or p_resolved_by is null or p_resolution_id is null or p_now is null then
    raise exception 'audit, template, reservation, actor, resolution id and timestamp are required';
  end if;
  if p_resolution is null or p_resolution not in ('no_campaign','campaign_created') then
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
     and a.status = 'ready'
     and a.launch_status = 'uncertain'
   for update;
  if not found then
    return jsonb_build_object('resolved', false, 'replayed', false);
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

    update public.ve_segmentation_audits
       set launch_status = 'failed',
           launch_error = 'Специалист подтвердил: кампания не создана',
           launch_resolution_id = p_resolution_id,
           launch_resolved_by = p_resolved_by,
           launch_resolved_at = p_now,
           launch_completed_at = p_now,
           updated_at = p_now
     where id = p_audit_id
       and launch_reservation_id = p_launch_reservation_id
       and launch_status = 'uncertain'
     returning * into v_audit;
    if not found then
      raise exception 'launch reservation changed before resolution';
    end if;
  else
    update public.ve_segmentation_audits
       set launch_status = 'running',
           launch_error = null,
           launch_heartbeat_at = p_now,
           updated_at = p_now
     where id = p_audit_id
       and launch_reservation_id = p_launch_reservation_id
       and launch_status = 'uncertain'
     returning * into v_audit;
    if not found then
      raise exception 'launch reservation changed before recovery';
    end if;

    v_finalize := public.ve_finalize_template_launch(
      p_audit_id,
      p_template_id,
      p_launch_reservation_id,
      'succeeded',
      p_launch_info,
      null,
      p_now
    );
    if coalesce((v_finalize ->> 'finalized')::boolean, false) is not true then
      raise exception 'recovered launch could not cross the shared finalize boundary';
    end if;

    update public.ve_segmentation_audits
       set launch_resolution_id = p_resolution_id,
           launch_resolved_by = p_resolved_by,
           launch_resolved_at = p_now,
           updated_at = p_now
     where id = p_audit_id
       and launch_reservation_id = p_launch_reservation_id
       and launch_status = 'succeeded'
     returning * into v_audit;
    if not found then
      raise exception 'launch reservation changed after recovery finalize';
    end if;
  end if;

  return jsonb_build_object(
    'resolved', true,
    'replayed', false,
    'audit_row', to_jsonb(v_audit),
    'launch_info', case when p_resolution = 'campaign_created' then p_launch_info else null end,
    'queue_item', case
      when p_resolution = 'campaign_created' then v_finalize -> 'queue_item'
      else null
    end
  );
end;
$$;

-- Date-derived RU timing is refreshed from the immutable evidence snapshot by
-- trusted application code. This RPC validates every item/hash under one
-- transaction, applies material changes atomically and advances the global
-- queue plan exactly once so stale activation clients must reload.
create or replace function public.ve_refresh_launch_seasonality_timing(
  p_portfolio_id text,
  p_items jsonb,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.ve_launch_portfolio_settings%rowtype;
  v_payload jsonb;
  v_item public.ve_launch_queue_items%rowtype;
  v_item_id uuid;
  v_seen_ids uuid[] := '{}'::uuid[];
  v_hash text;
  v_priority jsonb;
  v_state text;
  v_eligible boolean;
  v_latest_activation_at timestamptz;
  v_moscow_date text;
  v_changed boolean := false;
  v_count integer := 0;
  v_plan_version bigint;
begin
  if p_portfolio_id is null or p_items is null or p_now is null then
    raise exception 'portfolio, timing items and timestamp are required';
  end if;
  if p_portfolio_id <> 'ru' then
    raise exception 'seasonality timing refresh is restricted to the RU portfolio';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'timing items must be a JSON array';
  end if;
  select s.*
    into v_settings
    from public.ve_launch_portfolio_settings s
   where s.id = p_portfolio_id
   for update;
  if not found then
    raise exception 'launch portfolio % is not configured', p_portfolio_id;
  end if;
  if v_settings.timezone <> 'Europe/Moscow' then
    raise exception 'RU launch portfolio must use Europe/Moscow';
  end if;
  v_plan_version := v_settings.plan_version;
  v_moscow_date := to_char(p_now at time zone 'Europe/Moscow', 'YYYY-MM-DD');

  for v_payload in
    select value from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    if jsonb_typeof(v_payload) <> 'object' then
      raise exception 'timing refresh item must be an object';
    end if;

    begin
      v_item_id := nullif(btrim(v_payload ->> 'item_id'), '')::uuid;
    exception when others then
      raise exception 'timing refresh item_id must be a UUID';
    end;
    if v_item_id is null or v_item_id = any(v_seen_ids) then
      raise exception 'timing refresh item_id is missing or duplicated';
    end if;
    v_seen_ids := array_append(v_seen_ids, v_item_id);

    v_hash := nullif(btrim(v_payload ->> 'seasonality_input_hash'), '');
    if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'timing refresh requires a valid seasonality_input_hash';
    end if;
    v_priority := v_payload -> 'priority_snapshot';
    if jsonb_typeof(v_priority) <> 'object' then
      raise exception 'timing refresh requires priority_snapshot object';
    end if;
    v_state := v_priority ->> 'state';
    if v_state is null or v_state not in (
      'launch_now','prepare_now','neutral','unknown','wait','avoid'
    ) then
      raise exception 'invalid timing priority state';
    end if;
    if v_priority ->> 'evaluated_on' is distinct from v_moscow_date then
      raise exception 'timing priority snapshot is not evaluated for current Moscow date';
    end if;
    if jsonb_typeof(v_priority -> 'automatic_activation_eligible') <> 'boolean' then
      raise exception 'timing priority eligibility must be boolean';
    end if;
    v_eligible := (v_priority ->> 'automatic_activation_eligible')::boolean;
    if v_eligible is distinct from (v_state in ('launch_now','neutral')) then
      raise exception 'timing priority eligibility contradicts state';
    end if;

    if not (v_payload ? 'latest_activation_at') then
      raise exception 'timing refresh requires latest_activation_at';
    end if;
    if v_payload -> 'latest_activation_at' = 'null'::jsonb then
      v_latest_activation_at := null;
    else
      begin
        v_latest_activation_at := nullif(
          btrim(v_payload ->> 'latest_activation_at'),
          ''
        )::timestamptz;
      exception when others then
        raise exception 'latest_activation_at must be a timestamp or null';
      end;
      if v_latest_activation_at is null then
        raise exception 'latest_activation_at must be a timestamp or null';
      end if;
    end if;

    select q.*
      into v_item
      from public.ve_launch_queue_items q
     where q.id = v_item_id
       and q.portfolio_id = p_portfolio_id
       and q.status in ('prepared','queued')
     for update;
    if not found then
      raise exception 'timing refresh item % is missing or no longer refreshable', v_item_id;
    end if;
    if v_item.seasonality_input_hash is distinct from v_hash then
      raise exception 'immutable seasonality hash changed for item %', v_item_id;
    end if;
    if v_item.priority_snapshot is distinct from v_priority
       or v_item.latest_activation_at is distinct from v_latest_activation_at then
      v_changed := true;
    end if;
  end loop;

  if v_changed then
    update public.ve_launch_portfolio_settings
       set plan_version = plan_version + 1,
           updated_at = p_now
     where id = p_portfolio_id
     returning plan_version into v_plan_version;

    for v_payload in
      select value from jsonb_array_elements(p_items)
    loop
      v_item_id := (v_payload ->> 'item_id')::uuid;
      v_hash := v_payload ->> 'seasonality_input_hash';
      v_priority := v_payload -> 'priority_snapshot';
      if v_payload -> 'latest_activation_at' = 'null'::jsonb then
        v_latest_activation_at := null;
      else
        v_latest_activation_at := (v_payload ->> 'latest_activation_at')::timestamptz;
      end if;

      update public.ve_launch_queue_items
         set priority_snapshot = v_priority,
             latest_activation_at = v_latest_activation_at,
             updated_at = p_now
       where id = v_item_id
         and portfolio_id = p_portfolio_id
         and status in ('prepared','queued')
         and seasonality_input_hash = v_hash;
      if not found then
        raise exception 'timing refresh CAS lost for item %', v_item_id;
      end if;
    end loop;

    update public.ve_launch_queue_items
       set plan_version = v_plan_version,
           updated_at = p_now
     where portfolio_id = p_portfolio_id
       and status in ('prepared','queued');
  end if;

  return jsonb_build_object(
    'refreshed', true,
    'changed', v_changed,
    'refreshed_items', v_count,
    'plan_version', v_plan_version
  );
end;
$$;

create or replace function public.ve_reserve_launch_activation(
  p_item_id uuid,
  p_expected_plan_version bigint,
  p_activation_reservation_id uuid,
  p_idempotency_key uuid,
  p_actor_id uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.ve_launch_queue_items%rowtype;
  v_replay public.ve_launch_queue_items%rowtype;
  v_limit integer;
  v_mode text;
  v_occupied integer;
  v_head_id uuid;
  v_campaigns jsonb;
begin
  if p_item_id is null or p_activation_reservation_id is null or p_idempotency_key is null
     or p_actor_id is null
     or p_expected_plan_version is null or p_now is null then
    raise exception 'item, actor, plan, reservation, idempotency and timestamp are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 28082031));

  select q.*
    into v_replay
    from public.ve_launch_queue_items q
   where q.activation_idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_replay.id <> p_item_id then
      return jsonb_build_object(
        'reserved', false,
        'replayed', true,
        'code', 'VE_LAUNCH_IDEMPOTENCY_CONFLICT'
      );
    end if;
    select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at, c.id), '[]'::jsonb)
      into v_campaigns
      from public.ve_launch_queue_campaigns c
     where c.item_id = v_replay.id;
    return jsonb_build_object(
      'reserved', false,
      'replayed', true,
      'status', v_replay.status,
      'activation_reservation_id', v_replay.activation_reservation_id,
      'item', to_jsonb(v_replay),
      'campaigns', v_campaigns
    );
  end if;

  -- Read immutable scope before row locking, then acquire all mailbox locks in
  -- deterministic order. Overlapping bundles share at least one lock; disjoint
  -- pools and other workspaces remain concurrent.
  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id;
  if not found then
    return jsonb_build_object('reserved', false, 'replayed', false, 'code', 'VE_LAUNCH_ITEM_NOT_FOUND');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_item.instantly_account_id || ':' || m.mailbox_id, 28082032)
  )
    from unnest(v_item.mailbox_ids) as m(mailbox_id)
   order by m.mailbox_id;

  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id
   for update;
  if not found then
    return jsonb_build_object('reserved', false, 'replayed', false, 'code', 'VE_LAUNCH_ITEM_NOT_FOUND');
  end if;
  if v_item.status <> 'queued' then
    return jsonb_build_object('reserved', false, 'replayed', false, 'code', 'VE_LAUNCH_NOT_QUEUED');
  end if;
  if v_item.plan_version <> p_expected_plan_version then
    return jsonb_build_object('reserved', false, 'replayed', false, 'code', 'VE_LAUNCH_PLAN_STALE');
  end if;

  select s.max_active_bundles, s.mode
    into v_limit, v_mode
    from public.ve_launch_portfolio_settings s
   where s.id = v_item.portfolio_id;
  if not found then
    raise exception 'portfolio settings % not found', v_item.portfolio_id;
  end if;

  if v_item.not_before is not null and v_item.not_before > p_now then
    return jsonb_build_object(
      'reserved', false,
      'replayed', false,
      'code', 'VE_LAUNCH_TIMING_BLOCKED',
      'not_before', v_item.not_before
    );
  end if;
  if v_item.priority_override_decision = 'wait'
     and nullif(btrim(coalesce(v_item.priority_override_reason, '')), '') is not null
     and v_item.priority_overridden_by is not null
     and v_item.priority_overridden_at is not null then
    return jsonb_build_object(
      'reserved', false,
      'replayed', false,
      'code', 'VE_LAUNCH_TIMING_BLOCKED',
      'reason', 'manual_wait'
    );
  end if;
  if v_mode = 'enforced'
     and not (v_item.priority_snapshot @> '{"automatic_activation_eligible":true}'::jsonb)
     and not (
        nullif(btrim(coalesce(v_item.priority_override_reason, '')), '') is not null
        and v_item.priority_override_decision = 'activate_next'
        and v_item.priority_overridden_by is not null
        and v_item.priority_overridden_at is not null
      ) then
    return jsonb_build_object(
      'reserved', false,
      'replayed', false,
      'code', 'VE_LAUNCH_TIMING_BLOCKED',
      'reason', 'seasonality_not_eligible'
    );
  end if;

  select q.id
    into v_head_id
    from public.ve_launch_queue_items q
    join public.ve_launch_portfolio_settings qs on qs.id = q.portfolio_id
   where q.status = 'queued'
     and q.instantly_account_id = v_item.instantly_account_id
     and q.mailbox_ids && v_item.mailbox_ids
     and (q.not_before is null or q.not_before <= p_now)
     and not (
       q.priority_override_decision = 'wait'
       and nullif(btrim(coalesce(q.priority_override_reason, '')), '') is not null
       and q.priority_overridden_by is not null
       and q.priority_overridden_at is not null
     )
     and (
        qs.mode = 'advisory'
        or q.priority_snapshot @> '{"automatic_activation_eligible":true}'::jsonb
       or (
         nullif(btrim(coalesce(q.priority_override_reason, '')), '') is not null
         and q.priority_override_decision = 'activate_next'
         and q.priority_overridden_by is not null
         and q.priority_overridden_at is not null
       )
     )
   order by
     case when q.manual_order is null then 1 else 0 end,
     q.manual_order asc nulls last,
     q.latest_activation_at asc nulls last,
     case q.seasonality_confidence when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end desc,
     q.potential_pct desc,
     q.created_at asc,
     q.id asc
   limit 1;
  if v_head_id is distinct from v_item.id then
    return jsonb_build_object(
      'reserved', false,
      'replayed', false,
      'code', 'VE_LAUNCH_HIGHER_PRIORITY_PENDING',
      'blocking_item_id', v_head_id
    );
  end if;

  select count(*)::integer
    into v_occupied
    from public.ve_launch_queue_items q
   where q.id <> v_item.id
     and q.instantly_account_id = v_item.instantly_account_id
     and q.mailbox_ids && v_item.mailbox_ids
     and q.status in ('activating','active','uncertain');
  if v_occupied >= v_limit then
    return jsonb_build_object(
      'reserved', false,
      'replayed', false,
      'code', 'VE_LAUNCH_SLOT_OCCUPIED',
      'occupied_slots', v_occupied,
      'max_active_bundles', v_limit
    );
  end if;

  update public.ve_launch_queue_items
     set status = 'activating',
         activation_reservation_id = p_activation_reservation_id,
         activation_idempotency_key = p_idempotency_key,
         activation_started_by = p_actor_id,
         activation_started_at = p_now,
         activation_error = null,
         updated_at = p_now
   where id = p_item_id
     and status = 'queued'
     and plan_version = p_expected_plan_version
     and activation_reservation_id is null
   returning * into v_item;
  if not found then
    return jsonb_build_object('reserved', false, 'replayed', false, 'code', 'VE_LAUNCH_CAS_LOST');
  end if;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at, c.id), '[]'::jsonb)
    into v_campaigns
    from public.ve_launch_queue_campaigns c
   where c.item_id = v_item.id;
  if jsonb_array_length(v_campaigns) = 0 then
    raise exception 'launch bundle % has no campaigns', v_item.id;
  end if;

  return jsonb_build_object(
    'reserved', true,
    'replayed', false,
    'activation_reservation_id', p_activation_reservation_id,
    'item', to_jsonb(v_item),
    'campaigns', v_campaigns
  );
end;
$$;

create or replace function public.ve_finalize_launch_activation(
  p_item_id uuid,
  p_activation_reservation_id uuid,
  p_status text,
  p_error text,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.ve_launch_queue_items%rowtype;
begin
  if p_item_id is null or p_activation_reservation_id is null or p_now is null then
    raise exception 'item, reservation and timestamp are required';
  end if;
  if p_status is null or p_status not in ('active','uncertain') then
    raise exception 'activation terminal status must be active or uncertain';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_item_id::text, 28082033));

  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id
     and q.activation_reservation_id = p_activation_reservation_id
   for update;
  if not found then
    return jsonb_build_object('finalized', false, 'replayed', false);
  end if;
  if v_item.status = p_status then
    return jsonb_build_object('finalized', true, 'replayed', true, 'item', to_jsonb(v_item));
  end if;
  if v_item.status <> 'activating' then
    return jsonb_build_object('finalized', false, 'replayed', false, 'code', 'VE_LAUNCH_CAS_LOST');
  end if;

  update public.ve_launch_queue_items
     set status = p_status,
         activation_error = case
           when p_status = 'uncertain'
             then nullif(left(btrim(coalesce(p_error, '')), 500), '')
           else null
         end,
         ever_active_at = case
           when p_status = 'active' then coalesce(ever_active_at, p_now)
           else ever_active_at
         end,
         updated_at = p_now
   where id = p_item_id
     and activation_reservation_id = p_activation_reservation_id
     and status = 'activating'
   returning * into v_item;
  if not found then
    return jsonb_build_object('finalized', false, 'replayed', false, 'code', 'VE_LAUNCH_CAS_LOST');
  end if;

  return jsonb_build_object('finalized', true, 'replayed', false, 'item', to_jsonb(v_item));
end;
$$;

create or replace function public.ve_reconcile_launch_campaign_statuses(
  p_item_id uuid,
  p_campaigns jsonb,
  p_now timestamptz,
  p_max_observation_age interval default interval '5 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.ve_launch_queue_items%rowtype;
  v_observation record;
  v_campaign_count integer;
  v_all_completed boolean;
  v_all_active_or_completed boolean;
  v_any_active boolean;
  v_any_completed boolean;
  v_all_paused boolean;
  v_seen_campaign_ids text[] := '{}'::text[];
begin
  if p_item_id is null or p_now is null then
    raise exception 'item and timestamp are required';
  end if;
  if p_campaigns is null
     or jsonb_typeof(p_campaigns) <> 'array'
     or jsonb_array_length(p_campaigns) = 0 then
    raise exception 'campaign observations must be a non-empty array';
  end if;
  if p_max_observation_age is null or p_max_observation_age < interval '0 seconds' then
    raise exception 'max observation age must be non-negative';
  end if;

  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id;
  if not found then
    return jsonb_build_object('reconciled', false, 'code', 'VE_LAUNCH_ITEM_NOT_FOUND');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_item.instantly_account_id || ':' || m.mailbox_id, 28082032)
  )
    from unnest(v_item.mailbox_ids) as m(mailbox_id)
   order by m.mailbox_id;
  perform pg_advisory_xact_lock(hashtextextended(p_item_id::text, 28082033));

  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id
   for update;
  if not found then
    return jsonb_build_object('reconciled', false, 'code', 'VE_LAUNCH_ITEM_NOT_FOUND');
  end if;

  for v_observation in
    select *
      from jsonb_to_recordset(p_campaigns)
        as x(campaign_id text, status integer, status_observed_at timestamptz)
  loop
    if nullif(btrim(v_observation.campaign_id), '') is null
       or v_observation.status is null
       or v_observation.status not in (-99,-2,-1,0,1,2,3,4)
       or v_observation.status_observed_at is null
       or v_observation.status_observed_at > p_now + interval '1 minute' then
      raise exception 'invalid campaign observation';
    end if;
    if v_observation.campaign_id = any(v_seen_campaign_ids) then
      raise exception 'duplicate campaign observation: %', v_observation.campaign_id;
    end if;
    v_seen_campaign_ids := array_append(v_seen_campaign_ids, v_observation.campaign_id);

    if not exists (
      select 1
        from public.ve_launch_queue_campaigns c
       where c.item_id = p_item_id
         and c.campaign_id = v_observation.campaign_id
    ) then
      raise exception 'campaign % does not belong to bundle %', v_observation.campaign_id, p_item_id;
    end if;

    update public.ve_launch_queue_campaigns
       set remote_status = v_observation.status,
           status_observed_at = v_observation.status_observed_at,
           activated_at = case
             when v_observation.status in (1,3,4)
               then coalesce(activated_at, v_observation.status_observed_at)
             else activated_at
           end,
           completed_at = case
             when v_observation.status = 3
               then coalesce(completed_at, v_observation.status_observed_at)
             else completed_at
           end,
           updated_at = p_now
     where item_id = p_item_id
       and campaign_id = v_observation.campaign_id
       and (
         status_observed_at is null
         or status_observed_at <= v_observation.status_observed_at
       );
  end loop;

  select count(*)::integer
    into v_campaign_count
    from public.ve_launch_queue_campaigns c
   where c.item_id = p_item_id;
  if cardinality(v_seen_campaign_ids) <> v_campaign_count then
    raise exception 'campaign observations are not the exact bundle set for %', p_item_id;
  end if;

  select
    bool_and(
      c.remote_status = 3
      and c.status_observed_at is not null
      and c.status_observed_at >= p_now - p_max_observation_age
    ),
    bool_and(
      c.remote_status in (1,3,4)
      and c.status_observed_at is not null
      and c.status_observed_at >= p_now - p_max_observation_age
    ),
    bool_or(
      c.remote_status in (1,4)
      and c.status_observed_at is not null
      and c.status_observed_at >= p_now - p_max_observation_age
    ),
    bool_or(
      c.remote_status = 3
      and c.status_observed_at is not null
      and c.status_observed_at >= p_now - p_max_observation_age
    ),
    bool_and(
      c.remote_status = 2
      and c.status_observed_at is not null
      and c.status_observed_at >= p_now - p_max_observation_age
    )
    into v_all_completed, v_all_active_or_completed, v_any_active, v_any_completed, v_all_paused
    from public.ve_launch_queue_campaigns c
   where c.item_id = p_item_id;

  if v_campaign_count > 0
     and coalesce(v_all_completed, false) then
    update public.ve_launch_queue_items
       set status = 'released',
           ever_active_at = coalesce(ever_active_at, p_now),
           released_at = coalesce(released_at, p_now),
           release_reason = coalesce(release_reason, 'Все кампании завершены'),
           activation_error = null,
           updated_at = p_now
     where id = p_item_id
       and status in ('prepared','queued','activating','active','uncertain','released')
     returning * into v_item;
  elsif coalesce(v_all_active_or_completed, false)
        and coalesce(v_any_active, false) then
    update public.ve_launch_queue_items
       set status = 'active',
           ever_active_at = coalesce(ever_active_at, p_now),
           activation_error = null,
           released_at = null,
           released_by = null,
           release_reason = null,
           updated_at = p_now
     where id = p_item_id
       and status in ('prepared','queued','activating','active','uncertain','released')
     returning * into v_item;
  elsif coalesce(v_any_active, false)
        or coalesce(v_any_completed, false)
        or not coalesce(v_all_paused, false) then
    update public.ve_launch_queue_items
       set status = 'uncertain',
           ever_active_at = case
             when coalesce(v_any_active, false) or coalesce(v_any_completed, false)
               then coalesce(ever_active_at, p_now)
             else ever_active_at
           end,
           activation_error = 'Live reconciliation found a partial or inconsistent campaign state',
           released_at = null,
           released_by = null,
           release_reason = null,
           updated_at = p_now
     where id = p_item_id
       and status in ('prepared','queued','activating','active','uncertain','released')
     returning * into v_item;
  elsif coalesce(v_all_paused, false)
        and v_item.status in ('active','uncertain') then
    update public.ve_launch_queue_items
       set status = 'uncertain',
           activation_error = 'Live reconciliation found every campaign paused',
           updated_at = p_now
     where id = p_item_id
       and status in ('active','uncertain')
     returning * into v_item;
  end if;

  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id;

  return jsonb_build_object(
    'reconciled', true,
    'item', to_jsonb(v_item),
    'all_completed', coalesce(v_all_completed, false),
    'holds_slot', v_item.status in ('activating','active','uncertain')
  );
end;
$$;

create or replace function public.ve_manual_release_launch_slot(
  p_item_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_now timestamptz,
  p_max_observation_age interval default interval '5 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.ve_launch_queue_items%rowtype;
  v_campaign_count integer;
begin
  if p_actor_id is null or p_now is null then
    raise exception 'actor and timestamp are required';
  end if;
  p_reason := coalesce(btrim(p_reason), '');
  if p_reason = '' then
    return jsonb_build_object('released', false, 'replayed', false, 'code', 'REASON_REQUIRED');
  end if;
  if p_max_observation_age is null or p_max_observation_age < interval '0 seconds' then
    raise exception 'max observation age must be non-negative';
  end if;

  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id;
  if not found then
    return jsonb_build_object('released', false, 'replayed', false, 'code', 'VE_LAUNCH_ITEM_NOT_FOUND');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_item.instantly_account_id || ':' || m.mailbox_id, 28082032)
  )
    from unnest(v_item.mailbox_ids) as m(mailbox_id)
   order by m.mailbox_id;
  perform pg_advisory_xact_lock(hashtextextended(p_item_id::text, 28082033));

  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id
   for update;
  if not found then
    return jsonb_build_object('released', false, 'replayed', false, 'code', 'VE_LAUNCH_ITEM_NOT_FOUND');
  end if;
  if v_item.status = 'released' then
    return jsonb_build_object('released', true, 'replayed', true, 'item', to_jsonb(v_item));
  end if;
  if v_item.status = 'activating' then
    return jsonb_build_object(
      'released', false,
      'replayed', false,
      'code', 'VE_LAUNCH_ACTIVATION_IN_PROGRESS'
    );
  end if;
  if v_item.status not in ('active','uncertain') then
    return jsonb_build_object('released', false, 'replayed', false, 'code', 'BUNDLE_NOT_HOLDING_SLOT');
  end if;
  if v_item.status = 'uncertain'
     and coalesce(v_item.activation_started_at, v_item.updated_at) > p_now - interval '10 minutes' then
    return jsonb_build_object(
      'released', false,
      'replayed', false,
      'code', 'VE_LAUNCH_ACTIVATION_SETTLING'
    );
  end if;

  select count(*)::integer
    into v_campaign_count
    from public.ve_launch_queue_campaigns c
   where c.item_id = p_item_id;
  if v_campaign_count = 0 or exists (
    select 1
      from public.ve_launch_queue_campaigns c
     where c.item_id = p_item_id
       and (c.remote_status is null or c.status_observed_at is null)
  ) then
    return jsonb_build_object('released', false, 'replayed', false, 'code', 'LIVE_PROOF_REQUIRED');
  end if;
  if exists (
    select 1
      from public.ve_launch_queue_campaigns c
     where c.item_id = p_item_id
       and c.status_observed_at < p_now - p_max_observation_age
  ) then
    return jsonb_build_object('released', false, 'replayed', false, 'code', 'LIVE_PROOF_STALE');
  end if;
  if exists (
    select 1
      from public.ve_launch_queue_campaigns c
     where c.item_id = p_item_id
       and c.remote_status in (1,4)
  ) then
    return jsonb_build_object('released', false, 'replayed', false, 'code', 'CAMPAIGN_STILL_ACTIVE');
  end if;

  update public.ve_launch_queue_items
     set status = 'released',
         released_at = p_now,
         released_by = p_actor_id,
         release_reason = p_reason,
         updated_at = p_now
   where id = p_item_id
     and status in ('active','uncertain')
   returning * into v_item;
  if not found then
    return jsonb_build_object('released', false, 'replayed', false, 'code', 'VE_LAUNCH_CAS_LOST');
  end if;

  return jsonb_build_object('released', true, 'replayed', false, 'item', to_jsonb(v_item));
end;
$$;

-- Manual ranking/timing override. It serializes with activation admission for
-- the same mailbox scope, changes no lifecycle state and never releases or
-- preempts a capacity holder. Exact replays do not bump the plan again.
create or replace function public.ve_override_launch_priority(
  p_item_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_manual_order integer,
  p_not_before timestamptz,
  p_now timestamptz,
  p_decision text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.ve_launch_queue_items%rowtype;
  v_plan_version bigint;
begin
  if p_item_id is null or p_actor_id is null or p_now is null then
    raise exception 'item, actor and timestamp are required';
  end if;
  p_reason := coalesce(btrim(p_reason), '');
  if p_reason = '' then
    return jsonb_build_object('overridden', false, 'replayed', false, 'code', 'REASON_REQUIRED');
  end if;
  if p_manual_order is not null and p_manual_order < 0 then
    return jsonb_build_object(
      'overridden', false,
      'replayed', false,
      'code', 'VE_LAUNCH_MANUAL_ORDER_INVALID'
    );
  end if;
  p_decision := nullif(lower(btrim(coalesce(p_decision, ''))), '');
  if p_decision is not null and p_decision not in ('activate_next','wait') then
    return jsonb_build_object(
      'overridden', false,
      'replayed', false,
      'code', 'VE_LAUNCH_OVERRIDE_DECISION_INVALID'
    );
  end if;

  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id;
  if not found then
    return jsonb_build_object('overridden', false, 'replayed', false, 'code', 'VE_LAUNCH_ITEM_NOT_FOUND');
  end if;

  -- The API exposes one portfolio-wide plan version. Lock it before mailbox
  -- admission locks so concurrent overrides cannot publish split versions.
  select s.plan_version
    into v_plan_version
    from public.ve_launch_portfolio_settings s
   where s.id = v_item.portfolio_id
   for update;
  if not found then
    raise exception 'portfolio settings % not found', v_item.portfolio_id;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_item.instantly_account_id || ':' || m.mailbox_id, 28082032)
  )
    from unnest(v_item.mailbox_ids) as m(mailbox_id)
   order by m.mailbox_id;
  perform pg_advisory_xact_lock(hashtextextended(p_item_id::text, 28082033));

  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id
   for update;
  if not found then
    return jsonb_build_object('overridden', false, 'replayed', false, 'code', 'VE_LAUNCH_ITEM_NOT_FOUND');
  end if;
  if v_item.status not in ('prepared','queued') then
    return jsonb_build_object(
      'overridden', false,
      'replayed', false,
      'code', 'VE_LAUNCH_OVERRIDE_STATE_CONFLICT'
    );
  end if;

  if v_item.manual_order is not distinct from p_manual_order
     and v_item.not_before is not distinct from p_not_before
     and v_item.priority_override_decision is not distinct from p_decision
     and v_item.priority_overridden_by is not distinct from p_actor_id
     and v_item.priority_override_reason is not distinct from p_reason then
    return jsonb_build_object(
      'overridden', true,
      'replayed', true,
      'item', to_jsonb(v_item),
      'plan_version', v_item.plan_version
    );
  end if;

  update public.ve_launch_portfolio_settings
     set plan_version = plan_version + 1,
         updated_at = p_now
   where id = v_item.portfolio_id
   returning plan_version into v_plan_version;
  if not found then
    raise exception 'portfolio settings % not found', v_item.portfolio_id;
  end if;

  update public.ve_launch_queue_items
     set plan_version = v_plan_version,
         updated_at = p_now
   where portfolio_id = v_item.portfolio_id
     and status in ('prepared','queued');

  update public.ve_launch_queue_items
     set manual_order = p_manual_order,
         not_before = p_not_before,
         plan_version = v_plan_version,
         priority_override_reason = p_reason,
         priority_override_decision = p_decision,
         priority_overridden_by = p_actor_id,
         priority_overridden_at = p_now,
         updated_at = p_now
     where id = p_item_id
     and status in ('prepared','queued')
     and plan_version = v_plan_version
   returning * into v_item;
  if not found then
    return jsonb_build_object('overridden', false, 'replayed', false, 'code', 'VE_LAUNCH_CAS_LOST');
  end if;

  return jsonb_build_object(
    'overridden', true,
    'replayed', false,
    'item', to_jsonb(v_item),
    'plan_version', v_plan_version
  );
end;
$$;

revoke all on function public.ve_finalize_template_launch(uuid, uuid, uuid, text, jsonb, text, timestamptz) from public;
revoke all on function public.ve_resolve_template_launch(uuid, uuid, uuid, text, jsonb, uuid, uuid, timestamptz) from public;
revoke all on function public.ve_refresh_launch_seasonality_timing(text, jsonb, timestamptz) from public;
revoke all on function public.ve_reserve_launch_activation(uuid, bigint, uuid, uuid, uuid, timestamptz) from public;
revoke all on function public.ve_finalize_launch_activation(uuid, uuid, text, text, timestamptz) from public;
revoke all on function public.ve_reconcile_launch_campaign_statuses(uuid, jsonb, timestamptz, interval) from public;
revoke all on function public.ve_manual_release_launch_slot(uuid, uuid, text, timestamptz, interval) from public;
revoke all on function public.ve_override_launch_priority(uuid, uuid, text, integer, timestamptz, timestamptz, text) from public;

grant execute on function public.ve_finalize_template_launch(uuid, uuid, uuid, text, jsonb, text, timestamptz)
  to service_role, postgres;
grant execute on function public.ve_resolve_template_launch(uuid, uuid, uuid, text, jsonb, uuid, uuid, timestamptz)
  to service_role, postgres;
grant execute on function public.ve_refresh_launch_seasonality_timing(text, jsonb, timestamptz)
  to service_role, postgres;
grant execute on function public.ve_reserve_launch_activation(uuid, bigint, uuid, uuid, uuid, timestamptz)
  to service_role, postgres;
grant execute on function public.ve_finalize_launch_activation(uuid, uuid, text, text, timestamptz)
  to service_role, postgres;
grant execute on function public.ve_reconcile_launch_campaign_statuses(uuid, jsonb, timestamptz, interval)
  to service_role, postgres;
grant execute on function public.ve_manual_release_launch_slot(uuid, uuid, text, timestamptz, interval)
  to service_role, postgres;
grant execute on function public.ve_override_launch_priority(uuid, uuid, text, integer, timestamptz, timestamptz, text)
  to service_role, postgres;
