-- One Instantly campaign may belong to only one Portal project. The same
-- project may keep that campaign across several project periods.
--
-- Existing cross-project rows are normalized before the guard is enabled.
-- One manual project wins over stale automatic links. If there is no manual
-- owner, every conflicting automatic link is archived and removed so the
-- catalog can establish one fresh, evidence-backed owner. Competing manual
-- projects are never guessed: they abort the migration for explicit cleanup.

create table if not exists public.campaign_project_ownership_archive (
  id uuid primary key default gen_random_uuid(),
  original_link_id uuid not null,
  source_table text not null check (
    source_table in (
      'project_instantly_campaigns',
      'project_period_instantly_campaigns'
    )
  ),
  project_id uuid not null,
  period_id uuid,
  baseline_contacts integer,
  campaign_id text not null,
  match_source text not null,
  match_confidence real,
  match_reason text,
  original_created_at timestamptz,
  archived_at timestamptz not null default now(),
  archive_reason text not null,
  replacement_project_id uuid,
  unique(source_table, original_link_id, archive_reason)
);

alter table public.campaign_project_ownership_archive
  add column if not exists baseline_contacts integer;

create index if not exists idx_campaign_ownership_archive_campaign
  on public.campaign_project_ownership_archive(campaign_id, archived_at desc);

alter table public.campaign_project_ownership_archive enable row level security;
drop policy if exists "Service role full access on campaign ownership archive"
  on public.campaign_project_ownership_archive;
create policy "Service role full access on campaign ownership archive"
  on public.campaign_project_ownership_archive
  for all using (true) with check (true);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.campaign_project_ownership_archive to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'instantly') then
    grant all on public.campaign_project_ownership_archive to instantly;
  end if;
end $$;

do $$
declare
  v_conflict record;
  v_manual_project_ids uuid[];
  v_keep_project_id uuid;
begin
  -- Supabase applies a migration in one transaction. Hold both writer tables
  -- until the cleanup assertion and trigger installation have committed, so a
  -- concurrent catalog/period writer cannot recreate a cross-project row in
  -- the migration gap.
  lock table public.project_instantly_campaigns,
    public.project_period_instantly_campaigns
    in share row exclusive mode;

  for v_conflict in
    with all_owners as (
      select campaign_id, project_id
      from public.project_instantly_campaigns
      union all
      select campaign_id, project_id
      from public.project_period_instantly_campaigns
    )
    select campaign_id
    from all_owners
    group by campaign_id
    having count(distinct project_id) > 1
    order by campaign_id
  loop
    select coalesce(array_agg(distinct manual_owner.project_id), array[]::uuid[])
      into v_manual_project_ids
    from (
      select project_id
      from public.project_instantly_campaigns
      where campaign_id = v_conflict.campaign_id
        and match_source = 'manual'
      union all
      select project_id
      from public.project_period_instantly_campaigns
      where campaign_id = v_conflict.campaign_id
        and match_source = 'manual'
    ) manual_owner;

    if cardinality(v_manual_project_ids) > 1 then
      raise exception using
        errcode = '23514',
        message = 'manual_campaign_project_ownership_conflict',
        detail = format(
          'campaign %s has manual owners %s',
          v_conflict.campaign_id,
          array_to_string(v_manual_project_ids, ', ')
        );
    end if;

    v_keep_project_id := case
      when cardinality(v_manual_project_ids) = 1 then v_manual_project_ids[1]
      else null
    end;

    insert into public.campaign_project_ownership_archive (
      original_link_id,
      source_table,
      project_id,
      period_id,
      baseline_contacts,
      campaign_id,
      match_source,
      match_confidence,
      match_reason,
      original_created_at,
      archive_reason,
      replacement_project_id
    )
    select
      id,
      'project_instantly_campaigns',
      project_id,
      null,
      null::integer,
      campaign_id,
      match_source,
      match_confidence,
      match_reason,
      created_at,
      'migration_resolved_automatic_conflict',
      v_keep_project_id
    from public.project_instantly_campaigns
    where campaign_id = v_conflict.campaign_id
      and (v_keep_project_id is null or project_id <> v_keep_project_id)
    on conflict (source_table, original_link_id, archive_reason) do nothing;

    delete from public.project_instantly_campaigns
    where campaign_id = v_conflict.campaign_id
      and (v_keep_project_id is null or project_id <> v_keep_project_id);

    insert into public.campaign_project_ownership_archive (
      original_link_id,
      source_table,
      project_id,
      period_id,
      baseline_contacts,
      campaign_id,
      match_source,
      match_confidence,
      match_reason,
      original_created_at,
      archive_reason,
      replacement_project_id
    )
    select
      id,
      'project_period_instantly_campaigns',
      project_id,
      period_id,
      baseline_contacts,
      campaign_id,
      match_source,
      match_confidence,
      match_reason,
      created_at,
      'migration_resolved_automatic_conflict',
      v_keep_project_id
    from public.project_period_instantly_campaigns
    where campaign_id = v_conflict.campaign_id
      and (v_keep_project_id is null or project_id <> v_keep_project_id)
    on conflict (source_table, original_link_id, archive_reason) do nothing;

    delete from public.project_period_instantly_campaigns
    where campaign_id = v_conflict.campaign_id
      and (v_keep_project_id is null or project_id <> v_keep_project_id);
  end loop;

  if exists (
    with all_owners as (
      select campaign_id, project_id
      from public.project_instantly_campaigns
      union all
      select campaign_id, project_id
      from public.project_period_instantly_campaigns
    )
    select 1
    from all_owners
    group by campaign_id
    having count(distinct project_id) > 1
  ) then
    raise exception using
      errcode = '23514',
      message = 'campaign_project_ownership_cleanup_incomplete';
  end if;
end $$;

create or replace function public.reserve_project_period_instantly_campaigns(
  p_project_id uuid,
  p_links jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link jsonb;
  v_campaign_id text;
  v_conflicting_project_ids uuid[] := array[]::uuid[];
  v_link_count integer := 0;
begin
  if p_links is null or jsonb_typeof(p_links) <> 'array' then
    raise exception using errcode = '22023', message = 'period_campaign_links_array_required';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_links) link
    where coalesce(link->>'campaign_id', '') = ''
      or coalesce(link->>'period_id', '') = ''
      or coalesce(link->>'match_source', '') not in ('auto', 'auto-text', 'auto-ai', 'manual')
  ) then
    raise exception using errcode = '22023', message = 'invalid_period_campaign_link';
  end if;

  -- Stable ordering avoids deadlocks when two requests reserve overlapping
  -- campaign sets in opposite JSON order.
  for v_campaign_id in
    select distinct link->>'campaign_id'
    from jsonb_array_elements(p_links) link
    order by 1
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('instantly-campaign:' || v_campaign_id, 0)
    );
  end loop;

  select coalesce(array_agg(distinct owner.project_id), array[]::uuid[])
  into v_conflicting_project_ids
  from (
    select project_id
    from public.project_instantly_campaigns
    where campaign_id in (
      select link->>'campaign_id' from jsonb_array_elements(p_links) link
    )
      and project_id <> p_project_id
    union all
    select project_id
    from public.project_period_instantly_campaigns
    where campaign_id in (
      select link->>'campaign_id' from jsonb_array_elements(p_links) link
    )
      and project_id <> p_project_id
  ) owner;

  if cardinality(v_conflicting_project_ids) > 0 then
    return jsonb_build_object(
      'status', 'conflict',
      'conflicting_project_ids', to_jsonb(v_conflicting_project_ids)
    );
  end if;

  for v_link in select value from jsonb_array_elements(p_links)
  loop
    insert into public.project_period_instantly_campaigns (
      project_id,
      period_id,
      campaign_id,
      match_source,
      baseline_contacts,
      match_confidence,
      match_reason
    ) values (
      p_project_id,
      (v_link->>'period_id')::uuid,
      v_link->>'campaign_id',
      v_link->>'match_source',
      greatest(coalesce((v_link->>'baseline_contacts')::integer, 0), 0),
      (v_link->>'match_confidence')::real,
      v_link->>'match_reason'
    )
    on conflict (period_id, campaign_id) do update set
      project_id = excluded.project_id,
      match_source = case
        when project_period_instantly_campaigns.match_source = 'manual'
          and excluded.match_source <> 'manual'
        then project_period_instantly_campaigns.match_source
        else excluded.match_source
      end,
      baseline_contacts = case
        when project_period_instantly_campaigns.match_source = 'manual'
          and excluded.match_source <> 'manual'
        then project_period_instantly_campaigns.baseline_contacts
        else excluded.baseline_contacts
      end,
      match_confidence = case
        when project_period_instantly_campaigns.match_source = 'manual'
          and excluded.match_source <> 'manual'
        then project_period_instantly_campaigns.match_confidence
        else excluded.match_confidence
      end,
      match_reason = case
        when project_period_instantly_campaigns.match_source = 'manual'
          and excluded.match_source <> 'manual'
        then project_period_instantly_campaigns.match_reason
        else excluded.match_reason
      end;
    v_link_count := v_link_count + 1;
  end loop;

  return jsonb_build_object(
    'status', case when v_link_count > 0 then 'claimed' else 'unchanged' end,
    'conflicting_project_ids', '[]'::jsonb
  );
end;
$$;

create or replace function public.release_project_period_campaign_reservations(
  p_project_id uuid,
  p_period_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer := 0;
begin
  delete from public.project_period_instantly_campaigns
  where project_id = p_project_id
    and period_id = any(coalesce(p_period_ids, array[]::uuid[]));
  get diagnostics v_released = row_count;
  return jsonb_build_object('released', v_released);
end;
$$;

revoke all on function public.reserve_project_period_instantly_campaigns(uuid, jsonb)
  from public;
revoke all on function public.release_project_period_campaign_reservations(uuid, uuid[])
  from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.reserve_project_period_instantly_campaigns(uuid, jsonb) to service_role';
    execute 'grant execute on function public.release_project_period_campaign_reservations(uuid, uuid[]) to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'instantly') then
    execute 'grant execute on function public.reserve_project_period_instantly_campaigns(uuid, jsonb) to instantly';
    execute 'grant execute on function public.release_project_period_campaign_reservations(uuid, uuid[]) to instantly';
  end if;
end $$;

create or replace function public.enforce_instantly_campaign_single_project()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('instantly-campaign:' || new.campaign_id, 0)
  );

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

drop trigger if exists trg_project_campaign_single_project
  on public.project_instantly_campaigns;
create trigger trg_project_campaign_single_project
before insert or update of campaign_id, project_id
on public.project_instantly_campaigns
for each row execute function public.enforce_instantly_campaign_single_project();

drop trigger if exists trg_project_period_campaign_single_project
  on public.project_period_instantly_campaigns;
create trigger trg_project_period_campaign_single_project
before insert or update of campaign_id, project_id
on public.project_period_instantly_campaigns
for each row execute function public.enforce_instantly_campaign_single_project();

create or replace function public.claim_project_instantly_campaign(
  p_project_id uuid,
  p_campaign_id text,
  p_match_source text,
  p_period_id uuid default null,
  p_baseline_contacts integer default 0,
  p_match_confidence real default null,
  p_match_reason text default null,
  p_replace_automatic boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conflicting_project_ids uuid[] := array[]::uuid[];
  v_has_manual_conflict boolean := false;
  v_target_exists boolean := false;
  v_replaced boolean := false;
  v_deleted integer := 0;
begin
  if p_campaign_id is null or btrim(p_campaign_id) = '' then
    raise exception using errcode = '22023', message = 'campaign_id_required';
  end if;
  if p_match_source not in ('auto', 'auto-text', 'auto-ai', 'manual') then
    raise exception using errcode = '22023', message = 'invalid_campaign_match_source';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('instantly-campaign:' || p_campaign_id, 0)
  );

  select
    coalesce(array_agg(distinct owner.project_id), array[]::uuid[]),
    coalesce(bool_or(owner.match_source = 'manual'), false)
  into v_conflicting_project_ids, v_has_manual_conflict
  from (
    select project_id, match_source
    from public.project_instantly_campaigns
    where campaign_id = p_campaign_id
      and project_id <> p_project_id
    union all
    select project_id, match_source
    from public.project_period_instantly_campaigns
    where campaign_id = p_campaign_id
      and project_id <> p_project_id
  ) owner;

  if cardinality(v_conflicting_project_ids) > 0 then
    if not p_replace_automatic
      or p_match_source <> 'auto-text'
      or v_has_manual_conflict
    then
      return jsonb_build_object(
        'status', 'conflict',
        'conflicting_project_ids', to_jsonb(v_conflicting_project_ids)
      );
    end if;

    insert into public.campaign_project_ownership_archive (
      original_link_id,
      source_table,
      project_id,
      period_id,
      baseline_contacts,
      campaign_id,
      match_source,
      match_confidence,
      match_reason,
      original_created_at,
      archive_reason,
      replacement_project_id
    )
    select
      id,
      'project_instantly_campaigns',
      project_id,
      null,
      null::integer,
      campaign_id,
      match_source,
      match_confidence,
      match_reason,
      created_at,
      'replaced_stale_automatic_owner',
      p_project_id
    from public.project_instantly_campaigns
    where campaign_id = p_campaign_id
      and project_id <> p_project_id
      and match_source <> 'manual'
    on conflict (source_table, original_link_id, archive_reason) do nothing;

    delete from public.project_instantly_campaigns
    where campaign_id = p_campaign_id
      and project_id <> p_project_id
      and match_source <> 'manual';
    get diagnostics v_deleted = row_count;
    v_replaced := v_replaced or v_deleted > 0;

    insert into public.campaign_project_ownership_archive (
      original_link_id,
      source_table,
      project_id,
      period_id,
      baseline_contacts,
      campaign_id,
      match_source,
      match_confidence,
      match_reason,
      original_created_at,
      archive_reason,
      replacement_project_id
    )
    select
      id,
      'project_period_instantly_campaigns',
      project_id,
      period_id,
      baseline_contacts,
      campaign_id,
      match_source,
      match_confidence,
      match_reason,
      created_at,
      'replaced_stale_automatic_owner',
      p_project_id
    from public.project_period_instantly_campaigns
    where campaign_id = p_campaign_id
      and project_id <> p_project_id
      and match_source <> 'manual'
    on conflict (source_table, original_link_id, archive_reason) do nothing;

    delete from public.project_period_instantly_campaigns
    where campaign_id = p_campaign_id
      and project_id <> p_project_id
      and match_source <> 'manual';
    get diagnostics v_deleted = row_count;
    v_replaced := v_replaced or v_deleted > 0;

    -- Defensive re-check: the advisory lock serializes cooperating writers,
    -- while this also protects against a pre-existing manual row.
    if exists (
      select 1
      from public.project_instantly_campaigns
      where campaign_id = p_campaign_id and project_id <> p_project_id
    ) or exists (
      select 1
      from public.project_period_instantly_campaigns
      where campaign_id = p_campaign_id and project_id <> p_project_id
    ) then
      return jsonb_build_object(
        'status', 'conflict',
        'conflicting_project_ids', to_jsonb(v_conflicting_project_ids)
      );
    end if;
  end if;

  if p_period_id is null then
    select exists (
      select 1
      from public.project_instantly_campaigns
      where project_id = p_project_id and campaign_id = p_campaign_id
    ) into v_target_exists;

    insert into public.project_instantly_campaigns (
      project_id,
      campaign_id,
      match_source,
      match_confidence,
      match_reason
    ) values (
      p_project_id,
      p_campaign_id,
      p_match_source,
      p_match_confidence,
      p_match_reason
    )
    on conflict (project_id, campaign_id) do update set
      match_source = case
        when project_instantly_campaigns.match_source = 'manual'
          and excluded.match_source <> 'manual'
        then project_instantly_campaigns.match_source
        else excluded.match_source
      end,
      match_confidence = case
        when project_instantly_campaigns.match_source = 'manual'
          and excluded.match_source <> 'manual'
        then project_instantly_campaigns.match_confidence
        else excluded.match_confidence
      end,
      match_reason = case
        when project_instantly_campaigns.match_source = 'manual'
          and excluded.match_source <> 'manual'
        then project_instantly_campaigns.match_reason
        else excluded.match_reason
      end;
  else
    select exists (
      select 1
      from public.project_period_instantly_campaigns
      where project_id = p_project_id
        and period_id = p_period_id
        and campaign_id = p_campaign_id
    ) into v_target_exists;

    insert into public.project_period_instantly_campaigns (
      project_id,
      period_id,
      campaign_id,
      match_source,
      baseline_contacts,
      match_confidence,
      match_reason
    ) values (
      p_project_id,
      p_period_id,
      p_campaign_id,
      p_match_source,
      greatest(coalesce(p_baseline_contacts, 0), 0),
      p_match_confidence,
      p_match_reason
    )
    on conflict (period_id, campaign_id) do update set
      project_id = excluded.project_id,
      match_source = case
        when project_period_instantly_campaigns.match_source = 'manual'
          and excluded.match_source <> 'manual'
        then project_period_instantly_campaigns.match_source
        else excluded.match_source
      end,
      baseline_contacts = case
        when project_period_instantly_campaigns.match_source = 'manual'
          and excluded.match_source <> 'manual'
        then project_period_instantly_campaigns.baseline_contacts
        else excluded.baseline_contacts
      end,
      match_confidence = case
        when project_period_instantly_campaigns.match_source = 'manual'
          and excluded.match_source <> 'manual'
        then project_period_instantly_campaigns.match_confidence
        else excluded.match_confidence
      end,
      match_reason = case
        when project_period_instantly_campaigns.match_source = 'manual'
          and excluded.match_source <> 'manual'
        then project_period_instantly_campaigns.match_reason
        else excluded.match_reason
      end;
  end if;

  return jsonb_build_object(
    'status', case
      when v_replaced or not v_target_exists then 'claimed'
      else 'unchanged'
    end,
    'conflicting_project_ids', '[]'::jsonb
  );
end;
$$;

revoke all on function public.claim_project_instantly_campaign(
  uuid, text, text, uuid, integer, real, text, boolean
) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.claim_project_instantly_campaign(uuid, text, text, uuid, integer, real, text, boolean) to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'instantly') then
    execute 'grant execute on function public.claim_project_instantly_campaign(uuid, text, text, uuid, integer, real, text, boolean) to instantly';
  end if;
end $$;

create or replace function public.check_project_instantly_campaign_ownership(
  p_project_id uuid,
  p_campaign_ids text[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with foreign_owners as (
    select campaign_id, project_id
    from public.project_instantly_campaigns
    where campaign_id = any(coalesce(p_campaign_ids, array[]::text[]))
      and project_id <> p_project_id
    union all
    select campaign_id, project_id
    from public.project_period_instantly_campaigns
    where campaign_id = any(coalesce(p_campaign_ids, array[]::text[]))
      and project_id <> p_project_id
  ), grouped as (
    select
      campaign_id,
      array_agg(distinct project_id order by project_id) as conflicting_project_ids
    from foreign_owners
    group by campaign_id
  )
  select jsonb_build_object(
    'conflicts',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'campaign_id', campaign_id,
          'conflicting_project_ids', to_jsonb(conflicting_project_ids)
        )
        order by campaign_id
      ),
      '[]'::jsonb
    )
  )
  from grouped;
$$;

revoke all on function public.check_project_instantly_campaign_ownership(
  uuid, text[]
) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.check_project_instantly_campaign_ownership(uuid, text[]) to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'instantly') then
    execute 'grant execute on function public.check_project_instantly_campaign_ownership(uuid, text[]) to instantly';
  end if;
end $$;
