-- Add the `already_invited` lead status so we can distinguish leads we tried
-- to invite from leads we actually invited.
--
-- Background: when LinkedIn returns `already_invited` for a lead during the
-- invite step, the campaign runner used to set li_leads.status = 'invited' and
-- advance the campaign step. That made the Portal funnel show "Приглашены: 153"
-- while the LinkedIn account itself reported only 57 invitations sent — the
-- delta (96) was leads that returned already_invited (someone, possibly the
-- same account in a prior campaign, had already invited them) but were never
-- counted by LinkedIn as invites sent by us this run.
--
-- The new status lets the runner record the truth and the funnel UI split the
-- count: "Приглашены" = actually sent now, "Уже приглашены ранее" = skipped.

alter table public.li_leads
  drop constraint if exists li_leads_status_check;

alter table public.li_leads
  add constraint li_leads_status_check
  check (status in (
    'new',
    'invited',
    'already_invited',
    'connected',
    'messaged',
    'replied',
    'completed',
    'error'
  ));

comment on column public.li_leads.status is
  'Per-lead funnel stage. ''already_invited'' means LinkedIn refused our invite '
  'because the recipient was already invited (possibly by us in a previous '
  'campaign or by another tool) — we did NOT send an invite this run.';
