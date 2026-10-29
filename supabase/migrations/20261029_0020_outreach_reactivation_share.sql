-- Общий потолок реактивации RU — 20%: старые контакты AMO и возвраты каскада.
-- Считаем компании, а не адреса; набор очереди и скорость прежние.
create or replace function public.outreach_autofill_folder_state(p_folder_key text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with folder as (
    select id, mailbox_ids, send_weekdays, timezone
      from public.sender_folders
     where key = p_folder_key
  ), waiting as (
    select coalesce(r.group_key, r.id::text) as company_key,
           bool_or(coalesce(p.prior_contact, false) or coalesce(p.cascade_no, 1) > 1) as reactivation
      from public.sender_recipients r
      join public.sender_campaigns c on c.id = r.campaign_id
      join folder f on f.id = c.folder_id
      left join public.polza_ru_outreach_companies p
        on c.source_kind = 'polza_ru' and p.id::text = r.group_key
     where c.status in ('running', 'paused')
       and r.status = 'active'
       and r.last_step_sent = 0
     group by coalesce(r.group_key, r.id::text)
  )
  select case when f.id is null then null else jsonb_build_object(
    'folder_id', f.id,
    'per_day', coalesce((
      select sum(m.daily_campaign_limit)
        from public.sender_mailboxes m
       where m.id = any (coalesce(f.mailbox_ids, '{}'))
         and m.status = 'verified'
         and m.enabled
    ), 0),
    'remaining', (select count(*) from waiting),
    'reactivation_remaining', (select count(*) from waiting where reactivation),
    'send_weekdays', to_jsonb(f.send_weekdays),
    'timezone', f.timezone
  ) end
  from (select 1) one
  left join folder f on true;
$$;

revoke all on function public.outreach_autofill_folder_state(text) from public;
grant execute on function public.outreach_autofill_folder_state(text) to service_role;
