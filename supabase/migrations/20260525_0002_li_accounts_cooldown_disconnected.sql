-- Allow 'disconnected' as a cooldown_reason for when Unipile reports
-- the LinkedIn account is disconnected from the provider.

alter table public.li_accounts
  drop constraint if exists li_accounts_cooldown_reason_check;

alter table public.li_accounts
  add constraint li_accounts_cooldown_reason_check
    check (cooldown_reason is null
           or cooldown_reason in ('invitation_limit','already_invited','account_restricted','disconnected'));
