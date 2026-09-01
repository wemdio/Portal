-- Instantly DB: read one client's blocklist in a single MVCC snapshot.
--
-- Launch safety cannot be proven with several PostgREST pages: concurrent
-- delete+insert churn can preserve COUNT(*) while moving rows between pages.
-- Returning one bounded JSON value keeps count and emails in one statement
-- and bypasses the normal row-response cap without weakening the 10k guard.
-- 10001 is an overflow sentinel; the function never aggregates beyond it.

create or replace function public.client_blocklist_snapshot(
  p_client_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with bounded as materialized (
    select blocked.email
    from public.client_blocked_contacts blocked
    where blocked.client_user_id = p_client_user_id
    order by blocked.email
    limit 10001
  ), snapshot as (
    select
      count(*)::integer as entry_count,
      coalesce(jsonb_agg(bounded.email order by bounded.email), '[]'::jsonb) as emails
    from bounded
  )
  select jsonb_build_object(
    'count', snapshot.entry_count,
    'emails', case when snapshot.entry_count <= 10000 then snapshot.emails else '[]'::jsonb end
  )
  from snapshot;
$$;

revoke all on function public.client_blocklist_snapshot(uuid) from public;

do $$
declare
  grantee_name text;
begin
  foreach grantee_name in array array['anon', 'authenticated', 'instantly'] loop
    if exists (select 1 from pg_roles where rolname = grantee_name) then
      execute format(
        'revoke all on function public.client_blocklist_snapshot(uuid) from %I',
        grantee_name
      );
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.client_blocklist_snapshot(uuid) to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'instantly') then
    grant execute on function public.client_blocklist_snapshot(uuid) to instantly;
  end if;
end $$;

comment on function public.client_blocklist_snapshot(uuid) is
  'Bounded transactionally consistent email snapshot for fail-closed launch filtering.';
