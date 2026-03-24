alter table public.tg_outreach_dialogs
  add column if not exists tg_is_bot boolean not null default false,
  add column if not exists can_send boolean not null default true;

create index if not exists tg_outreach_dialogs_campaign_can_send_idx
  on public.tg_outreach_dialogs (campaign_id, can_send);

create index if not exists tg_outreach_dialogs_campaign_is_bot_idx
  on public.tg_outreach_dialogs (campaign_id, tg_is_bot);
