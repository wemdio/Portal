-- Mailbox outcomes: leads are what we PASSED to the client — rows that are
-- visible in the client's lead table (project_client_lead_board_rows), not every
-- thread our qualification marked as a lead (CEO, 16.10.2026).
--
-- The earlier definition (20261012_0001) counted every claimed qualification
-- that produced a Telegram alert. That includes threads a specialist then
-- rejected with «Не лид» and manual handoffs that were never sent: both stay
-- out of the client table, so the dashboard overstated what we gave clients.
--
-- The view already applies the visibility rules (review candidates, rejected
-- and unsent manual handoffs are hidden). qualification_id IS NOT NULL keeps
-- only rows our worker created, not rows the client imported by hand.
-- The day is the reply's day, like replies on the same dashboard.
create or replace function public.instantly_project_leads_daily(p_from date, p_to date)
returns table(day text, leads bigint)
language sql stable security invoker
set search_path = public
as $$
  select to_char(coalesce(r.reply_timestamp, r.created_at) at time zone 'UTC', 'YYYY-MM-DD') as day,
         count(*) as leads
  from public.project_client_lead_board_rows r
  where r.qualification_id is not null
    and coalesce(r.reply_timestamp, r.created_at) >= p_from::timestamp at time zone 'UTC'
    and coalesce(r.reply_timestamp, r.created_at) < (p_to + 1)::timestamp at time zone 'UTC'
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
