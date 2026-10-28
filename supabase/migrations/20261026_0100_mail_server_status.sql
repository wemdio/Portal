-- Our own mail servers (Postfix/Dovecot on VDSina and play2go) report their state
-- for the admin page «Почтовые серверы» (owner 2026-10-26: «чтобы другой тех
-- специалист тоже мог заходить и смотреть … и чтобы это обновлялось всегда»).
--
-- Every server posts a heartbeat every 15 minutes (mail-pilot/mail-heartbeat.py)
-- to /api/mail-servers/heartbeat; one row per server holds the latest report:
-- addresses and PTR names, domains and Instantly connection names, mailbox
-- counts, service state, mail of the day, blocklist hits and the alert bot's
-- active problems. The report carries no passwords, keys or env values.
-- Service role only. Additive: no existing table changes.

create table if not exists public.mail_server_status (
  server_id text primary key,
  payload jsonb not null,
  received_at timestamp with time zone not null default now(),
  source_ip text
);

alter table public.mail_server_status enable row level security;
revoke all on table public.mail_server_status from anon, authenticated;
grant all on public.mail_server_status to service_role;
