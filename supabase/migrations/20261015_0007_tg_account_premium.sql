-- Telegram Premium у аккаунтов TG-аутрича (15.10.2026): флаг premium приходит
-- от Telegram при проверке аккаунта; null — аккаунт ещё не проверяли.
alter table public.tg_outreach_accounts add column if not exists tg_premium boolean;
