-- tg-outreach resilience: track consecutive AUTH_KEY_DUPLICATED errors per account.
--
-- When the worker connects an account and Telegram replies with
-- 406: AUTH_KEY_DUPLICATED, it means the session is shared with another login
-- and can never recover until the user re-authenticates. The worker increments
-- this counter; on the third consecutive failure it sets is_active=false and
-- writes a warning to tg_outreach_logs, so a single dead session doesn't keep
-- driving the worker into watchdog restarts.
--
-- The counter resets to 0 on any successful connect.

alter table public.tg_outreach_accounts
  add column if not exists auth_key_dup_count integer not null default 0;

comment on column public.tg_outreach_accounts.auth_key_dup_count is
  'Consecutive AUTH_KEY_DUPLICATED errors during connect. Resets to 0 on success. '
  'At 3, the worker sets is_active=false and emits a warning in tg_outreach_logs.';
