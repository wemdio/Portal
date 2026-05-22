-- Track when the Unipile invite-accepted webhook sent the campaign's
-- welcome_message to a lead. Used by the campaign runner to skip the first
-- regular message step if the welcome has already been delivered — otherwise
-- the lead gets two messages back-to-back (the webhook welcome + the runner's
-- scheduled follow-up). See the matching commit for the broken-template +
-- duplicated-follow-up bug on the Nadezhda Davudova account.

alter table public.li_campaign_leads
  add column if not exists welcome_sent_at timestamptz null;

comment on column public.li_campaign_leads.welcome_sent_at is
  'When the connection_accepted webhook successfully sent campaign.welcome_message '
  'to this lead. Null = never sent. The runner uses this to skip the first '
  'message/follow_up step so the welcome and the scheduled follow-up do not '
  'duplicate each other.';
