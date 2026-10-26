-- OutreachOS: ответ лиду с общей почтой в копии, как у автоаутрича и наших email-кампаний.
alter table public.agency_lead_handoff_settings drop constraint if exists agency_lead_handoff_settings_scope_check;
alter table public.agency_lead_handoff_settings add constraint agency_lead_handoff_settings_scope_check
  check (scope in ('auto_ru','auto_en','own_ru','own_en','outreachos'));

-- Выключено; адреса копии и тексты берём у email-аутрича RU, включает пользователь.
insert into public.agency_lead_handoff_settings (scope, cc_emails, colleague_text, self_text)
select 'outreachos', cc_emails, colleague_text, self_text
from public.agency_lead_handoff_settings where scope = 'own_ru'
on conflict (scope) do nothing;

alter table public.outreachos_lead_pushes
  add column if not exists instantly_email_id text,
  add column if not exists instantly_campaign_id text;

create or replace function public.enqueue_agency_lead_handoffs()
returns void language sql set search_path = public as $$
  insert into agency_lead_handoffs (scope, source, source_id, lead_email, recipient_id)
  select s.scope, 'sender', q.reply_id::text, lower(trim(coalesce(nullif(reply.from_email, ''), r.email))), r.id
  from sender_reply_qualifications q
  join sender_recipients r on r.id = q.recipient_id
  join sender_replies reply on reply.id = q.reply_id and reply.kind = 'human'
  join sender_campaigns c on c.id = q.campaign_id
  join sender_folders f on f.id = c.folder_id
  join agency_lead_handoff_settings s on s.scope = f.key
  where s.enabled and f.key in ('auto_ru','auto_en')
    and f.leads_enabled and f.leads_telegram
    and q.status = 'lead' and q.tg_sent_at is not null
    and q.qualified_at >= s.enabled_at
    and (r.lead_verdict_source is distinct from 'manual' or r.lead_verdict is distinct from 'not_lead')
    and r.status not in ('unsubscribed','bounced','stopped')
    and not exists (select 1 from agency_lead_handoffs h
      where h.source = 'sender' and lower(h.lead_email) = lower(trim(coalesce(nullif(reply.from_email,''),r.email))))
  order by q.qualified_at
  limit 200
  on conflict do nothing;

  insert into agency_lead_handoffs (scope, source, source_id, lead_email)
  select s.scope, 'instantly', q.email_id, lower(trim(q.lead_email))
  from own_reply_qualifications q
  join own_reply_crm_pushes p on p.qualification_id = q.email_id
  join agency_lead_handoff_settings s
    on s.scope = case when q.campaign_name ~* '^\s*enagency\y' then 'own_en' else 'own_ru' end
  join own_reply_lead_settings own on own.id = 1 and own.enabled
  where s.enabled and q.status = 'lead' and p.tg_sent_at is not null
    and q.qualified_at >= s.enabled_at
    and (q.campaign_name ~* '^\s*enagency\y' or q.campaign_name ~* '^\s*\d+\s*\.\s*polza')
    and not exists (select 1 from agency_lead_handoffs h
      where h.source = 'instantly' and lower(h.lead_email) = lower(trim(q.lead_email)))
  order by q.qualified_at
  limit 200
  on conflict do nothing;

  insert into agency_lead_handoffs (scope, source, source_id, lead_email)
  select s.scope, 'instantly', p.instantly_email_id, lower(trim(p.lead_email))
  from outreachos_lead_pushes p
  join agency_lead_handoff_settings s on s.scope = 'outreachos'
  where s.enabled and p.kind = 'reply' and p.tg_sent_at is not null
    and p.instantly_email_id is not null and p.instantly_campaign_id is not null
    and p.created_at >= s.enabled_at
    and not exists (select 1 from agency_lead_handoffs h
      where h.source = 'instantly' and lower(h.lead_email) = lower(trim(p.lead_email)))
  order by p.created_at
  limit 200
  on conflict do nothing;
$$;
revoke all on function public.enqueue_agency_lead_handoffs() from public, anon, authenticated;
grant execute on function public.enqueue_agency_lead_handoffs() to service_role;
