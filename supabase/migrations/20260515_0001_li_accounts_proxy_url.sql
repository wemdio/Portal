-- LinkedIn Outreach: per-account proxy override + updated_at.
--
-- Why: PATCH /api/tools/li-outreach/accounts/[id] сохраняет proxy_url
-- на конкретный LinkedIn-аккаунт и пишет updated_at. Но таблица
-- li_accounts (создана в 20260320_0001) этих колонок не имела —
-- PostgREST падал с «Could not find the 'updated_at' column of
-- 'li_accounts' in the schema cache» при добавлении прокси.
--
-- proxy_url:  NULL = аккаунт ходит без отдельного прокси (через общий
--             li_settings.proxy_url либо напрямую).
-- updated_at: автоматически обновляется триггером при любом UPDATE.

alter table public.li_accounts
  add column if not exists proxy_url  text,
  add column if not exists updated_at timestamptz not null default now();

-- Авто-обновление updated_at при любом UPDATE строки.
create or replace function public.set_li_accounts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_li_accounts_set_updated_at on public.li_accounts;
create trigger trg_li_accounts_set_updated_at
  before update on public.li_accounts
  for each row execute function public.set_li_accounts_updated_at();

comment on column public.li_accounts.proxy_url is
  'Персональный прокси для этого LinkedIn-аккаунта (Unipile). NULL — без отдельного прокси.';
comment on column public.li_accounts.updated_at is
  'Авто-обновляется триггером trg_li_accounts_set_updated_at при каждом UPDATE.';
