-- RU/EN auto-outreach leads already delivered to Sales Polza General -> AMO.
-- Activation begins at migration time: older Telegram leads are not replayed.
alter table public.sender_reply_qualifications
  add column if not exists tg_message_text text;

create table if not exists public.sender_auto_lead_crm_activation (
  id smallint primary key default 1 check (id = 1),
  started_at timestamptz not null default now()
);
insert into public.sender_auto_lead_crm_activation (id) values (1) on conflict (id) do nothing;
alter table public.sender_auto_lead_crm_activation enable row level security;
grant select on public.sender_auto_lead_crm_activation to service_role;

create table if not exists public.sender_auto_lead_crm_pushes (
  id uuid primary key default gen_random_uuid(),
  reply_id uuid not null unique references public.sender_reply_qualifications(reply_id) on delete cascade,
  recipient_id uuid not null references public.sender_recipients(id) on delete cascade,
  campaign_id uuid not null references public.sender_campaigns(id) on delete cascade,
  lead_email text not null,
  contact_name text not null,
  company_name text,
  sub_source text not null check (sub_source in ('Автоаутрич RU', 'Автоаутрич EN')),
  telegram_html text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  action text check (action in ('created', 'note_added')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  amo_contact_id bigint,
  amo_company_id bigint,
  amo_lead_id bigint,
  lead_url text,
  note_sent_at timestamptz,
  sent_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_sender_auto_lead_crm_email
  on public.sender_auto_lead_crm_pushes (lower(lead_email));
create index if not exists idx_sender_auto_lead_crm_due
  on public.sender_auto_lead_crm_pushes (next_attempt_at)
  where status = 'pending';
alter table public.sender_auto_lead_crm_pushes enable row level security;
grant all on public.sender_auto_lead_crm_pushes to service_role;

create index if not exists idx_sender_reply_qualifications_auto_crm
  on public.sender_reply_qualifications (tg_sent_at)
  where status = 'lead' and tg_sent_at is not null;

-- Reconciles a crash between Telegram delivery and CRM queue insertion. The
-- unique email key also suppresses another positive reply in a second campaign.
create or replace function public.enqueue_sender_auto_leads_crm()
returns integer language sql security invoker set search_path = public as $$
  with inserted as (
    insert into public.sender_auto_lead_crm_pushes (
      reply_id, recipient_id, campaign_id, lead_email, contact_name,
      company_name, sub_source, telegram_html
    )
    select q.reply_id, q.recipient_id, q.campaign_id,
           lower(coalesce(nullif(btrim(p.from_email), ''), btrim(r.email))),
           coalesce(nullif(btrim(p.from_name), ''),
                    lower(coalesce(nullif(btrim(p.from_email), ''), btrim(r.email)))),
           nullif(btrim(r.name), ''),
           case f.key when 'auto_ru' then 'Автоаутрич RU' else 'Автоаутрич EN' end,
           q.tg_message_text
    from public.sender_reply_qualifications q
    join public.sender_replies p on p.id = q.reply_id
    join public.sender_recipients r on r.id = q.recipient_id
    join public.sender_campaigns c on c.id = q.campaign_id
    join public.sender_folders f on f.id = c.folder_id
    cross join public.sender_auto_lead_crm_activation a
    where a.id = 1
      and ((f.key = 'auto_ru' and c.source_kind = 'polza_ru')
        or (f.key = 'auto_en' and c.source_kind = 'polza_en'))
      and q.status = 'lead' and q.tg_sent_at >= a.started_at
      and q.tg_message_text is not null
      and not (r.lead_verdict_source = 'manual' and r.lead_verdict = 'not_lead')
      and nullif(coalesce(nullif(btrim(p.from_email), ''), btrim(r.email)), '') is not null
      and not exists (
        select 1 from public.sender_auto_lead_crm_pushes x
        where x.reply_id = q.reply_id
           or lower(x.lead_email) = lower(coalesce(nullif(btrim(p.from_email), ''), btrim(r.email)))
      )
    order by q.tg_sent_at, q.reply_id
    limit 100
    on conflict do nothing
    returning 1
  )
  select count(*)::integer from inserted;
$$;
revoke all on function public.enqueue_sender_auto_leads_crm() from public;
grant execute on function public.enqueue_sender_auto_leads_crm() to service_role;
