-- Профиль TG-аккаунта в портале: имя, фамилия, описание, аватарка.
--
-- Раньше этих полей не было вовсе: список кампании показывал session_name и
-- телефон. Аватарка у аккаунтов ПУЛА (tg_pool_accounts.avatar_url) —
-- косметическая: картинка лежит в хранилище портала и в Telegram не уходит.
-- Здесь поля хранят то, что реально стоит в Telegram: после каждой правки
-- профиль перечитывается и перезаписывается.

alter table public.tg_outreach_accounts
  add column if not exists first_name text not null default '';
alter table public.tg_outreach_accounts
  add column if not exists last_name text not null default '';
alter table public.tg_outreach_accounts
  add column if not exists bio text not null default '';
alter table public.tg_outreach_accounts
  add column if not exists avatar_url text not null default '';
alter table public.tg_outreach_accounts
  add column if not exists profile_synced_at timestamptz;

comment on column public.tg_outreach_accounts.profile_synced_at is
  'Когда профиль последний раз перечитывался из Telegram. NULL — ни разу.';
