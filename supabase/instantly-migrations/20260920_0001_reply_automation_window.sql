-- Operational Instantly DB. A durable no-backfill boundary, not an AI verdict.
-- The initial cutoff is set ONCE. Reapplying/redeploying must not move it.
begin;

create table if not exists public.instantly_qualification_automation_policy (
  id boolean primary key default true check (id),
  not_before timestamptz not null default clock_timestamp()
);
insert into public.instantly_qualification_automation_policy (id)
values (true) on conflict (id) do nothing;
alter table public.instantly_qualification_automation_policy enable row level security;
revoke all on table public.instantly_qualification_automation_policy from public;

-- A historical intake item is withdrawn, not classified as not_lead. Its
-- original payload and explicit reason remain available for an audit.
create or replace function public.skip_historical_instantly_reply_intake(
  p_account_id text, p_email_id text, p_lease_token uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_row public.instantly_reply_intake%rowtype;
  v_now timestamptz := clock_timestamp();
  v_not_before timestamptz;
begin
  select not_before into strict v_not_before
    from public.instantly_qualification_automation_policy where id;
  select * into v_row from public.instantly_reply_intake
    where account_id = p_account_id and email_id = p_email_id for update;
  if not found or p_lease_token is null or v_row.state <> 'processing'
    or v_row.lease_token is distinct from p_lease_token
    or v_row.lease_until is null or v_row.lease_until <= v_now then
    return jsonb_build_object('state', 'lease_lost');
  end if;
  if least(v_row.reply_timestamp, v_row.created_at) >= v_not_before
    and least(v_row.reply_timestamp, v_row.created_at) > v_now - interval '24 hours' then
    return jsonb_build_object('state', 'not_historical');
  end if;
  update public.instantly_reply_intake
    set state = 'accepted', accepted_at = v_now, updated_at = v_now,
      lease_token = null, lease_until = null,
      last_error_code = 'historical_processing_disabled'
    where account_id = p_account_id and email_id = p_email_id;
  return jsonb_build_object('state', 'skipped');
end;
$$;
revoke all on function public.skip_historical_instantly_reply_intake(text, text, uuid) from public;

do $$
declare v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'instantly'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on table public.instantly_qualification_automation_policy from %I', v_role);
      execute format('revoke all on function public.skip_historical_instantly_reply_intake(text, text, uuid) from %I', v_role);
      if v_role in ('service_role', 'instantly') then
        execute format('grant select on table public.instantly_qualification_automation_policy to %I', v_role);
        execute format('drop policy if exists %I on public.instantly_qualification_automation_policy', v_role || '_automation_policy_read');
        execute format('create policy %I on public.instantly_qualification_automation_policy for select to %I using (true)', v_role || '_automation_policy_read', v_role);
        execute format('grant execute on function public.skip_historical_instantly_reply_intake(text, text, uuid) to %I', v_role);
      end if;
    end if;
  end loop;
end $$;
-- grants-lint: no-service-role-grant public.instantly_qualification_automation_policy — dynamic role-safe SELECT grant above; no runtime writes.
notify pgrst, 'reload schema';
commit;
