-- Mailbox outcomes: count our qualified project threads, not Instantly's
-- interested label. The durable specialist claim is also what gates Telegram
-- alerts and the per-project lead board, so repeat positive replies count once.
create or replace function public.instantly_project_leads_daily(p_from date, p_to date)
returns table(day text, leads bigint)
language sql stable security invoker
set search_path = public
as $$
  select to_char(coalesce(q.reply_timestamp, q.created_at) at time zone 'UTC', 'YYYY-MM-DD') as day,
         count(*) as leads
  from public.instantly_specialist_alert_decisions d
  join public.instantly_lead_qualifications q on q.id = d.qualification_id
  where d.is_claimant is true
    and q.status = 'lead'
    and q.qualified_project_owner_proven is true
    and q.qualified_project_id = d.project_id
    and coalesce(q.reply_timestamp, q.created_at) >= p_from::timestamp at time zone 'UTC'
    and coalesce(q.reply_timestamp, q.created_at) < (p_to + 1)::timestamp at time zone 'UTC'
  group by 1
  order by 1;
$$;

revoke all on function public.instantly_project_leads_daily(date, date) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.instantly_project_leads_daily(date, date) to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'instantly') then
    execute 'grant execute on function public.instantly_project_leads_daily(date, date) to instantly';
  end if;
end $$;
