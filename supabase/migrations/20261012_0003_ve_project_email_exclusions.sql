-- Exact recipient exclusions, beside existing company INN/domain rules.
-- No providers, recipient rewrites, collection restarts or paid work.
alter table public.ve_project_exclusions add column emails text[] not null default '{}';
alter table public.ve_project_exclusion_changes add column email_count integer not null default 0;
alter table public.ve_project_exclusions drop constraint ve_project_exclusions_check;
alter table public.ve_project_exclusions add constraint ve_project_exclusions_check
  check (cardinality(inns) + cardinality(domains) + cardinality(emails) <= 10000);

-- Separate name avoids an ambiguous five-argument overload during rollout.
-- NULL means an older client did not edit email rules; [] explicitly clears.
create function public.ve_save_project_exclusions_v2(
  p_project_id uuid, p_revision integer, p_inns text[], p_domains text[], p_actor_id uuid,
  p_emails text[] default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_previous integer;
  v_emails text[];
  v_result public.ve_project_exclusions%rowtype;
begin
  perform 1 from public.ve_projects where id = p_project_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  select revision, emails into v_previous, v_emails
    from public.ve_project_exclusions where project_id = p_project_id for update;
  if p_revision is null or p_revision < 0 or p_actor_id is null
    or p_inns is null or p_domains is null
    then return jsonb_build_object('error', 'invalid'); end if;
  if coalesce(v_previous, 0) <> p_revision then return jsonb_build_object('error', 'conflict'); end if;
  v_emails := coalesce(p_emails, v_emails, '{}'::text[]);
  if cardinality(p_inns) + cardinality(p_domains) + cardinality(v_emails) > 10000
    or exists (select 1 from unnest(p_inns) x where x is null or x !~ '^([0-9]{10}|[0-9]{12})$')
    or exists (select 1 from unnest(p_domains) x where x is null or length(x) > 253
      or x !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z0-9-]+$')
    or exists (select 1 from unnest(v_emails) x where x is null or length(x) > 254
      or x <> lower(x) or x ~ '[[:space:][:cntrl:]*]'
      or x !~ '^[a-z0-9.!#$%&''+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
      or length(split_part(x, '@', 1)) > 64
      or split_part(x, '@', 1) ~ '(^\.|\.$|\.\.)'
      or length(substring(x from '[^.]+$')) < 2
      or exists (select 1 from unnest(string_to_array(split_part(x, '@', 2), '.')) label where length(label) > 63))
    then return jsonb_build_object('error', 'invalid'); end if;
  insert into public.ve_project_exclusions(project_id,revision,inns,domains,emails,updated_by)
    values(p_project_id,p_revision+1,
      array(select distinct x from unnest(p_inns) x order by x),
      array(select distinct x from unnest(p_domains) x order by x),
      array(select distinct x from unnest(v_emails) x order by x),p_actor_id)
    on conflict(project_id) do update set revision=excluded.revision,
      inns=excluded.inns,domains=excluded.domains,emails=excluded.emails,
      updated_by=excluded.updated_by,updated_at=clock_timestamp()
    returning * into v_result;
  insert into public.ve_project_exclusion_changes(project_id,revision,actor_id,inn_count,domain_count,email_count)
    values(p_project_id,v_result.revision,p_actor_id,cardinality(v_result.inns),cardinality(v_result.domains),cardinality(v_result.emails));
  return jsonb_build_object('revision',v_result.revision,'inns',v_result.inns,
    'domains',v_result.domains,'emails',v_result.emails,'updated_at',v_result.updated_at);
end;
$$;
revoke all on function public.ve_save_project_exclusions_v2(uuid,integer,text[],text[],uuid,text[]) from public, anon, authenticated;
grant execute on function public.ve_save_project_exclusions_v2(uuid,integer,text[],text[],uuid,text[]) to service_role;

-- Existing callers keep exact INN/domain semantics without deleting email rules.
create or replace function public.ve_save_project_exclusions(
  p_project_id uuid, p_revision integer, p_inns text[], p_domains text[], p_actor_id uuid
) returns jsonb language sql security definer set search_path = '' as $$
  select public.ve_save_project_exclusions_v2(p_project_id,p_revision,p_inns,p_domains,p_actor_id,null::text[]);
$$;
revoke all on function public.ve_save_project_exclusions(uuid,integer,text[],text[],uuid) from public, anon, authenticated;
grant execute on function public.ve_save_project_exclusions(uuid,integer,text[],text[],uuid) to service_role;
