-- Store Telegram user id in company contacts for cases without public username.

alter table public.company_contacts
  add column if not exists channel_tg_user_id bigint;

comment on column public.company_contacts.channel_tg_user_id is
  'Telegram numeric user id from phone enrichment; used when public username is missing';
