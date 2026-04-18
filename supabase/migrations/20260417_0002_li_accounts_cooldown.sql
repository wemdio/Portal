-- LinkedIn Outreach: park an account in cooldown when LinkedIn returns an
-- invitation-limit / already-invited / restricted-account signal.
--
-- Why: today the campaign runner keeps hammering Unipile every 100-200s after
-- LinkedIn rejects an invite, which raises the risk of permanently losing the
-- LI account. By recording cooldown_until on li_accounts, every campaign and
-- scraper task tied to that account will quietly skip its tick until the
-- cooldown expires.

alter table public.li_accounts
  add column if not exists cooldown_until  timestamptz,
  add column if not exists cooldown_reason text
    check (cooldown_reason is null
           or cooldown_reason in ('invitation_limit','already_invited','account_restricted'));

-- Partial index — most accounts will have NULL here, only the few currently
-- parked rows need to be findable by "is this account cooling down right now?"
create index if not exists idx_li_accounts_cooldown
  on public.li_accounts(cooldown_until)
  where cooldown_until is not null;

comment on column public.li_accounts.cooldown_until  is
  'When set and >now(), the campaign runner & scraper skip every operation that uses this LinkedIn account. Cleared automatically when expiry passes.';
comment on column public.li_accounts.cooldown_reason is
  'Why the account was parked: invitation_limit (LI weekly invite cap), already_invited (lead list contains stale duplicates), account_restricted (LI flagged the account as spam).';
