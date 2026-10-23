-- Статус аккаунта в Unipile как есть (OK, CREDENTIALS, ERROR, STOPPED…): портал
-- показывает его в карточке, а is_active остаётся «OK / не OK».
alter table public.li_accounts
  add column if not exists unipile_status text;

comment on column public.li_accounts.unipile_status is
  'Raw Unipile source status of the account (OK, CREDENTIALS, ERROR, STOPPED, ...); refreshed by the account sync every 15 minutes.';
