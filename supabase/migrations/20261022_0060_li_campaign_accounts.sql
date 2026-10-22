-- Несколько LinkedIn-аккаунтов на одну кампанию.
--
-- li_campaigns.account_id остаётся «основным» аккаунтом (первым в списке) —
-- на нём держатся старые кампании, воркер и отчёты. Остальные — здесь.
-- Один аккаунт — одна кампания: unique(account_id) не даёт взять его в две.
-- Дневной счётчик инвайтов у каждого аккаунта свой (лимит кампании — на аккаунт).
create table if not exists public.li_campaign_accounts (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid not null references public.li_campaigns(id) on delete cascade,
  account_id         uuid not null references public.li_accounts(id) on delete cascade,
  position           integer not null default 0,
  invites_sent_today integer not null default 0,
  last_invite_date   date,
  created_at         timestamptz not null default now(),
  unique (campaign_id, account_id),
  unique (account_id)
);

create index if not exists li_campaign_accounts_campaign_idx
  on public.li_campaign_accounts (campaign_id, position);

alter table public.li_campaign_accounts enable row level security;

drop policy if exists li_campaign_accounts_select_all on public.li_campaign_accounts;
create policy li_campaign_accounts_select_all on public.li_campaign_accounts
  for select to authenticated using (true);

grant all on public.li_campaign_accounts to service_role;
grant select on public.li_campaign_accounts to authenticated;

-- С какого аккаунта кампании идёт работа с лидом. null — ещё не распределён
-- (воркер распределит на ближайшем тике) или кампания с одним аккаунтом.
alter table public.li_campaign_leads
  add column if not exists account_id uuid references public.li_accounts(id) on delete set null;

create index if not exists li_campaign_leads_account_idx
  on public.li_campaign_leads (campaign_id, account_id);

create or replace function public.li_campaign_account_increment_invite(
  p_campaign_id uuid,
  p_account_id  uuid,
  p_today       date
)
returns integer
language plpgsql
as $$
declare
  new_value integer;
begin
  update public.li_campaign_accounts
  set
    invites_sent_today =
      case
        when last_invite_date = p_today then invites_sent_today + 1
        else 1
      end,
    last_invite_date = p_today
  where campaign_id = p_campaign_id and account_id = p_account_id
  returning invites_sent_today into new_value;

  if new_value is null then
    raise exception 'li_campaign_account_increment_invite: account % is not in campaign %', p_account_id, p_campaign_id
      using errcode = 'P0002';
  end if;

  return new_value;
end;
$$;

comment on table public.li_campaign_accounts is
  'LinkedIn accounts of a campaign (several per campaign, one campaign per account) with per-account daily invite counters.';
