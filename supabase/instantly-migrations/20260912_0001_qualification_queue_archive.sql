-- Instantly operational DB only. Administrative queue withdrawal is NOT a
-- qualification verdict. No rows are archived merely by applying this migration.
begin;

alter table public.instantly_lead_qualifications
  add column if not exists queue_archived_at timestamptz,
  add column if not exists queue_archive_batch_id uuid;

alter table public.instantly_lead_qualifications
  drop constraint if exists instantly_qualification_queue_archive_pair;
alter table public.instantly_lead_qualifications
  add constraint instantly_qualification_queue_archive_pair check (
    (queue_archived_at is null) = (queue_archive_batch_id is null)
  );

comment on column public.instantly_lead_qualifications.queue_archived_at is
  'Explicit administrative withdrawal from automatic processing; not not_lead. Original evidence, verdict and attempt counters remain intact. Restore only through the audited restore RPC.';

create table if not exists public.instantly_qualification_archive_batches (
  batch_id uuid primary key,
  qualification_ids uuid[] not null,
  reason text not null,
  created_at timestamptz not null default clock_timestamp(),
  result jsonb
);

create table if not exists public.instantly_qualification_archive_entries (
  batch_id uuid not null references public.instantly_qualification_archive_batches(batch_id),
  qualification_id uuid not null,
  outcome text not null check (outcome in ('archived', 'skipped')),
  skip_reason text,
  original_metadata jsonb,
  archived_at timestamptz,
  restored_at timestamptz,
  restore_reason text,
  primary key (batch_id, qualification_id),
  constraint instantly_qualification_archive_entry_state check (
    (outcome = 'archived' and archived_at is not null and original_metadata is not null and skip_reason is null)
    or (outcome = 'skipped' and archived_at is null and original_metadata is null and skip_reason is not null)
  )
);

create unique index if not exists instantly_qualification_one_active_archive
  on public.instantly_qualification_archive_entries (qualification_id)
  where outcome = 'archived' and restored_at is null;
create index if not exists instantly_qualification_archive_batch_idx
  on public.instantly_lead_qualifications (queue_archive_batch_id)
  where queue_archived_at is not null;

alter table public.instantly_qualification_archive_batches enable row level security;
alter table public.instantly_qualification_archive_entries enable row level security;

-- Called after the other BEFORE triggers, so even an older trigger's implicit
-- ownership inference cannot change the final archived row. Updating archive
-- metadata alone does not invoke the column-scoped ownership trigger.
-- The ledger is writable only by the definer RPCs (and the database owner).
create or replace function public.enforce_instantly_qualification_queue_archive()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_operation text := current_setting('portal.qualification_archive_operation', true);
begin
  if tg_op = 'DELETE' then
    if old.queue_archived_at is not null then
      raise exception using errcode = '23514', message = 'qualification_queue_archived';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.queue_archived_at is not null or new.queue_archive_batch_id is not null then
      raise exception using errcode = '23514', message = 'qualification_queue_archive_requires_rpc';
    end if;
    return new;
  end if;

  if old.queue_archived_at is null and new.queue_archived_at is null
     and old.queue_archive_batch_id is null and new.queue_archive_batch_id is null then
    return new;
  end if;
  if to_jsonb(new) = to_jsonb(old) then
    return new;
  end if;

  -- No business fields may change during archive/restore, including status,
  -- owner proof, source IDs, snapshots, AI budgets and recovery attempts.
  if (to_jsonb(new) - array['queue_archived_at', 'queue_archive_batch_id', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['queue_archived_at', 'queue_archive_batch_id', 'updated_at']) then
    raise exception using errcode = '23514', message = 'qualification_queue_archived';
  end if;

  if old.queue_archived_at is null and new.queue_archived_at is not null
     and v_operation = 'archive:' || new.queue_archive_batch_id::text
     and new.updated_at = new.queue_archived_at
     and exists (
       select 1 from public.instantly_qualification_archive_entries e
       where e.batch_id = new.queue_archive_batch_id and e.qualification_id = new.id
         and e.outcome = 'archived' and e.archived_at = new.queue_archived_at
         and e.restored_at is null
     ) then
    return new;
  end if;

  if old.queue_archived_at is not null and new.queue_archived_at is null
     and new.queue_archive_batch_id is null
     and v_operation = 'restore:' || old.queue_archive_batch_id::text
     and exists (
       select 1 from public.instantly_qualification_archive_entries e
       where e.batch_id = old.queue_archive_batch_id and e.qualification_id = old.id
         and e.outcome = 'archived' and e.archived_at = old.queue_archived_at
         and e.restored_at = new.updated_at
     ) then
    return new;
  end if;

  raise exception using errcode = '23514', message = 'qualification_queue_archive_requires_rpc';
end;
$$;

drop trigger if exists zzz_qualification_queue_archive_fence
  on public.instantly_lead_qualifications;
create trigger zzz_qualification_queue_archive_fence
before insert or update or delete on public.instantly_lead_qualifications
for each row execute function public.enforce_instantly_qualification_queue_archive();

create or replace function public.archive_instantly_qualification_queue(
  p_batch_id uuid,
  p_qualification_ids uuid[],
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ids uuid[];
  v_id uuid;
  v_batch public.instantly_qualification_archive_batches%rowtype;
  v_row public.instantly_lead_qualifications%rowtype;
  v_skip text;
  v_now timestamptz;
  v_previous_operation text := current_setting('portal.qualification_archive_operation', true);
  v_result jsonb;
begin
  if p_batch_id is null or p_qualification_ids is null
     or cardinality(p_qualification_ids) not between 1 and 5000
     or array_ndims(p_qualification_ids) <> 1
     or array_position(p_qualification_ids, null) is not null
     or nullif(btrim(p_reason), '') is null or length(p_reason) > 1000 then
    raise exception using errcode = '22023', message = 'qualification_queue_archive_invalid_manifest';
  end if;
  select array_agg(distinct id order by id) into v_ids from unnest(p_qualification_ids) id;
  if cardinality(v_ids) <> cardinality(p_qualification_ids) then
    raise exception using errcode = '22023', message = 'qualification_queue_archive_duplicate_ids';
  end if;

  -- Exact manifest + batch identity make uncertain network retries safe. Never
  -- widen a previously approved batch to include replies that arrived later.
  perform pg_advisory_xact_lock(hashtextextended('qualification-archive:' || p_batch_id::text, 0));
  select * into v_batch from public.instantly_qualification_archive_batches where batch_id = p_batch_id;
  if found then
    if v_batch.qualification_ids is distinct from v_ids or v_batch.reason is distinct from btrim(p_reason) then
      raise exception using errcode = '22023', message = 'qualification_queue_archive_batch_manifest_mismatch';
    end if;
    return v_batch.result || jsonb_build_object('replayed', true);
  end if;

  insert into public.instantly_qualification_archive_batches (batch_id, qualification_ids, reason)
  values (p_batch_id, v_ids, btrim(p_reason));
  perform set_config('portal.qualification_archive_operation', 'archive:' || p_batch_id::text, true);

  foreach v_id in array v_ids loop
    v_skip := null;
    -- This lock and the current status are the CAS boundary. A worker which
    -- claimed or completed the row first wins; never interrupt a processing row.
    select * into v_row from public.instantly_lead_qualifications
      where id = v_id for update skip locked;
    if not found then
      v_skip := 'missing_or_locked';
    elsif v_row.queue_archived_at is not null then
      v_skip := 'already_archived';
    elsif v_row.status not in ('pending', 'needs_review', 'error') then
      v_skip := 'processing_or_terminal';
    elsif exists (select 1 from public.client_forwarded_leads where qualification_id = v_id)
       or exists (select 1 from public.instantly_pending_handoffs where qualification_id = v_id)
       or exists (select 1 from public.instantly_specialist_alert_decisions where qualification_id = v_id)
       or exists (select 1 from public.instantly_lead_handoff_outbox where qualification_id = v_id) then
      v_skip := 'delivery_protected';
    end if;

    if v_skip is not null then
      insert into public.instantly_qualification_archive_entries (batch_id, qualification_id, outcome, skip_reason)
      values (p_batch_id, v_id, 'skipped', v_skip);
      continue;
    end if;

    v_now := clock_timestamp();
    insert into public.instantly_qualification_archive_entries
      (batch_id, qualification_id, outcome, original_metadata, archived_at)
    values (
      p_batch_id, v_id, 'archived',
      -- Large source bodies are retained once in the fenced qualification row.
      -- The ledger keeps the exact pre-archive operational metadata for audit.
      to_jsonb(v_row) - array['reply_body', 'reply_preview', 'last_outbound_preview', 'reply_recovery_snapshot'],
      v_now
    );
    update public.instantly_lead_qualifications
    set queue_archived_at = v_now, queue_archive_batch_id = p_batch_id, updated_at = v_now
    where id = v_id;
  end loop;

  select jsonb_build_object(
    'batch_id', p_batch_id, 'requested', cardinality(v_ids),
    'archived', count(*) filter (where e.outcome = 'archived'),
    'skipped', count(*) filter (where e.outcome = 'skipped'),
    'replayed', false,
    'results', jsonb_agg(jsonb_build_object('id', e.qualification_id, 'outcome', e.outcome, 'reason', e.skip_reason)
      order by e.qualification_id)
  ) into v_result
  from public.instantly_qualification_archive_entries e where e.batch_id = p_batch_id;
  update public.instantly_qualification_archive_batches set result = v_result where batch_id = p_batch_id;
  perform set_config('portal.qualification_archive_operation', coalesce(v_previous_operation, ''), true);
  return v_result;
end;
$$;

create or replace function public.restore_instantly_qualification_queue(
  p_batch_id uuid,
  p_qualification_ids uuid[],
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ids uuid[];
  v_id uuid;
  v_row public.instantly_lead_qualifications%rowtype;
  v_skip text;
  v_now timestamptz;
  v_previous_operation text := current_setting('portal.qualification_archive_operation', true);
  v_restored integer := 0;
  v_results jsonb := '[]'::jsonb;
begin
  if p_batch_id is null or p_qualification_ids is null
     or cardinality(p_qualification_ids) not between 1 and 5000
     or array_ndims(p_qualification_ids) <> 1
     or array_position(p_qualification_ids, null) is not null
     or nullif(btrim(p_reason), '') is null or length(p_reason) > 1000 then
    raise exception using errcode = '22023', message = 'qualification_queue_restore_invalid_manifest';
  end if;
  select array_agg(distinct id order by id) into v_ids from unnest(p_qualification_ids) id;
  if cardinality(v_ids) <> cardinality(p_qualification_ids) then
    raise exception using errcode = '22023', message = 'qualification_queue_restore_duplicate_ids';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('qualification-archive:' || p_batch_id::text, 0));
  if not exists (select 1 from public.instantly_qualification_archive_batches where batch_id = p_batch_id) then
    raise exception using errcode = '22023', message = 'qualification_queue_restore_batch_not_found';
  end if;
  -- Reject nonmembers atomically, rather than silently restoring a wider scope.
  if exists (
    select 1 from unnest(v_ids) id where not exists (
      select 1 from public.instantly_qualification_archive_entries e
      where e.batch_id = p_batch_id and e.qualification_id = id and e.outcome = 'archived'
    )
  ) then
    raise exception using errcode = '22023', message = 'qualification_queue_restore_manifest_mismatch';
  end if;
  perform set_config('portal.qualification_archive_operation', 'restore:' || p_batch_id::text, true);

  foreach v_id in array v_ids loop
    v_skip := null;
    select * into v_row from public.instantly_lead_qualifications where id = v_id for update skip locked;
    if not found then
      v_skip := 'missing_or_locked';
    elsif v_row.queue_archive_batch_id is distinct from p_batch_id or v_row.queue_archived_at is null then
      v_skip := 'not_archived_by_batch';
    else
      v_now := clock_timestamp();
      update public.instantly_qualification_archive_entries
      set restored_at = v_now, restore_reason = btrim(p_reason)
      where batch_id = p_batch_id and qualification_id = v_id and restored_at is null;
      if not found then
        raise exception using errcode = '23514', message = 'qualification_queue_restore_ledger_mismatch';
      end if;
      update public.instantly_lead_qualifications
      set queue_archived_at = null, queue_archive_batch_id = null, updated_at = v_now
      where id = v_id;
      v_restored := v_restored + 1;
    end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'id', v_id, 'outcome', case when v_skip is null then 'restored' else 'skipped' end, 'reason', v_skip
    ));
  end loop;
  perform set_config('portal.qualification_archive_operation', coalesce(v_previous_operation, ''), true);
  return jsonb_build_object('batch_id', p_batch_id, 'requested', cardinality(v_ids),
    'restored', v_restored, 'skipped', cardinality(v_ids) - v_restored, 'results', v_results);
end;
$$;

revoke all on function public.enforce_instantly_qualification_queue_archive() from public;
revoke all on function public.archive_instantly_qualification_queue(uuid, uuid[], text) from public;
revoke all on function public.restore_instantly_qualification_queue(uuid, uuid[], text) from public;
revoke all on table public.instantly_qualification_archive_batches from public;
revoke all on table public.instantly_qualification_archive_entries from public;

-- Hosted service_role and the self-hosted Instantly database role only. No
-- direct ledger writes: a caller cannot fabricate the trigger's authorization.
do $$
declare v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'instantly'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function public.enforce_instantly_qualification_queue_archive() from %I', v_role);
      execute format('revoke all on function public.archive_instantly_qualification_queue(uuid, uuid[], text) from %I', v_role);
      execute format('revoke all on function public.restore_instantly_qualification_queue(uuid, uuid[], text) from %I', v_role);
      execute format('revoke all on table public.instantly_qualification_archive_batches from %I', v_role);
      execute format('revoke all on table public.instantly_qualification_archive_entries from %I', v_role);
      if v_role in ('service_role', 'instantly') then
        execute format('grant execute on function public.archive_instantly_qualification_queue(uuid, uuid[], text) to %I', v_role);
        execute format('grant execute on function public.restore_instantly_qualification_queue(uuid, uuid[], text) to %I', v_role);
        execute format('grant select on table public.instantly_qualification_archive_batches to %I', v_role);
        execute format('grant select on table public.instantly_qualification_archive_entries to %I', v_role);
        execute format('drop policy if exists %I on public.instantly_qualification_archive_batches', v_role || '_archive_read');
        execute format('create policy %I on public.instantly_qualification_archive_batches for select to %I using (true)', v_role || '_archive_read', v_role);
        execute format('drop policy if exists %I on public.instantly_qualification_archive_entries', v_role || '_archive_read');
        execute format('create policy %I on public.instantly_qualification_archive_entries for select to %I using (true)', v_role || '_archive_read', v_role);
      end if;
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
