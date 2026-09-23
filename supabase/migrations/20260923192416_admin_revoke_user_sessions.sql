create or replace function public.admin_revoke_user_sessions(target_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  revoked_count integer;
begin
  delete from auth.sessions
  where user_id = target_user_id;

  get diagnostics revoked_count = row_count;
  return revoked_count;
end;
$$;

revoke all on function public.admin_revoke_user_sessions(uuid) from public;
revoke all on function public.admin_revoke_user_sessions(uuid) from anon;
revoke all on function public.admin_revoke_user_sessions(uuid) from authenticated;
grant execute on function public.admin_revoke_user_sessions(uuid) to service_role;
