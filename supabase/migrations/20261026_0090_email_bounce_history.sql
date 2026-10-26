-- Bounce memory for the email validator (owner 2026-10-26: «делай учёт отказов
-- в валидаторе»).
--
-- SMTP cannot tell a dead mailbox on the Mail.ru group (every address there
-- comes out catch_all) or on a catch-all company domain. Our own sends can: in
-- 01.08–09.10.2026 a re-send to an address that had already bounced bounced
-- again in 69% of cases on the Mail.ru group and 64% on catch-all company
-- domains, against 33% for addresses SMTP had confirmed. The validator reads
-- this view for catch_all verdicts (app/src/lib/emailValidation/sharedCache.ts,
-- bouncedBefore).
--
-- Sources: the Instantly bounce webhook (instantly_activity_events, since
-- 12.10.2026), hard bounces of our own sender (sender_suppressions) and earlier
-- Instantly lead statuses imported from instantly_dataset.raw_leads by
-- app/scripts/email-validation/import-dataset-bounces.sh after deploy.
-- Instantly gives no bounce reason, so a policy refusal of our sending mailbox
-- looks like a dead mailbox; an address that opened or replied after its last
-- bounce is therefore alive and left out. Service role only. Additive: no
-- existing table changes; the lookup indexes are built online in 20261026_0091
-- and 20261026_0092.

create table if not exists public.email_bounce_import (
  email text primary key,
  last_bounced_at timestamp with time zone not null,
  bounces integer not null default 1,
  source text not null,
  imported_at timestamp with time zone not null default now()
);

alter table public.email_bounce_import enable row level security;
revoke all on table public.email_bounce_import from anon, authenticated;
grant all on public.email_bounce_import to service_role;

create or replace view public.email_bounce_history as
select b.email, b.last_bounced_at, b.bounces
from (
  select email, max(bounced_at) as last_bounced_at, sum(bounces)::integer as bounces
  from (
    select lower(lead_email) as email, occurred_at as bounced_at, 1 as bounces
    from public.instantly_activity_events
    where event_type = 'bounced'
    union all
    select lower(email), created_at, 1
    from public.sender_suppressions
    where reason = 'hard_bounce'
    union all
    select email, last_bounced_at, bounces
    from public.email_bounce_import
  ) bounced
  group by email
) b
where not exists (
  select 1
  from public.instantly_activity_events alive
  where lower(alive.lead_email) = b.email
    and alive.event_type in ('opened', 'replied')
    and alive.occurred_at > b.last_bounced_at
);

alter view public.email_bounce_history set (security_invoker = on);
revoke all on table public.email_bounce_history from anon, authenticated;
grant select on public.email_bounce_history to service_role;
