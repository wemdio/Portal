-- Agency campaigns only: send a short reply with the sales owner in CC after TG delivery.
create table if not exists public.agency_lead_handoff_settings (
  scope text primary key check (scope in ('auto_ru','auto_en','own_ru','own_en')),
  enabled boolean not null default false,
  enabled_at timestamptz,
  cc_emails text[] not null default '{}',
  self_sender_emails text[] not null default '{}',
  colleague_text text not null,
  self_text text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  check (not enabled or (enabled_at is not null and cardinality(cc_emails) > 0))
);
alter table public.agency_lead_handoff_settings enable row level security;
revoke all on public.agency_lead_handoff_settings from anon, authenticated;
grant all on public.agency_lead_handoff_settings to service_role;

insert into public.agency_lead_handoff_settings (scope, colleague_text, self_text)
select scope,
  case when scope like '%_en' then
    'Thanks for your interest! I''ve copied my colleague, who will get back to you shortly.'
  else 'Спасибо за интерес! Добавляю в копию коллегу, чтобы продолжить общение. Скоро вернёмся с ответом.' end,
  case when scope like '%_en' then
    'Thanks for your interest! I''ve copied my main email address and will get back to you from there shortly.'
  else 'Спасибо за интерес! Добавляю в копию свою основную почту. Скоро вернусь с ответом уже с неё.' end
from unnest(array['auto_ru','auto_en','own_ru','own_en']) scope
on conflict (scope) do nothing;

create table if not exists public.agency_lead_handoffs (
  id uuid primary key default gen_random_uuid(),
  scope text not null references public.agency_lead_handoff_settings(scope),
  source text not null check (source in ('sender','instantly')),
  source_id text not null,
  lead_email text not null,
  recipient_id uuid references public.sender_recipients(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','sending','queued','sent','failed','unknown','skipped')),
  body text,
  cc_emails text[],
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_id)
);
-- One introduction per person per sending system, across RU/EN campaigns.
create unique index if not exists agency_lead_handoffs_person_idx
  on public.agency_lead_handoffs(source, lower(lead_email));
create index if not exists agency_lead_handoffs_due_idx
  on public.agency_lead_handoffs(next_attempt_at) where status = 'pending';
alter table public.agency_lead_handoffs enable row level security;
revoke all on public.agency_lead_handoffs from anon, authenticated;
grant all on public.agency_lead_handoffs to service_role;

alter table public.sender_manual_messages
  add column if not exists cc_emails text[] not null default '{}',
  add column if not exists agency_handoff_id uuid unique references public.agency_lead_handoffs(id);

-- Reconciliation is durable: a crash after Telegram delivery does not lose the reply.
-- Enabling/re-enabling starts a new window; historical leads are never mailed.
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
$$;
revoke all on function public.enqueue_agency_lead_handoffs() from public, anon, authenticated;
grant execute on function public.enqueue_agency_lead_handoffs() to service_role;

-- An interrupted auto-introduction must never be reclaimed and sent twice.
-- Existing operator replies retain their previous stale recovery behaviour.
create or replace function public.claim_sender_manual_messages(
  p_limit integer, p_egress_ip text, p_stale_after_seconds integer default 600
)
returns setof public.sender_manual_messages language plpgsql as $$
begin
  return query
  with picked as (
    select mm.id
    from public.sender_manual_messages mm
    join public.sender_mailboxes mb on mb.id = mm.mailbox_id
    where (mm.status = 'queued' or
      (mm.status = 'sending' and mm.agency_handoff_id is null
        and mm.updated_at < now() - make_interval(secs => p_stale_after_seconds)))
      and mb.egress_ip = p_egress_ip
    order by mm.created_at limit p_limit for update of mm skip locked
  )
  update public.sender_manual_messages m
    set status = 'sending', updated_at = now()
    from picked where m.id = picked.id returning m.*;
end;
$$;
