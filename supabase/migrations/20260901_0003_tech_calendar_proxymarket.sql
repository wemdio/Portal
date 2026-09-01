-- Add proxy.market to tech calendar provider sync.

alter table public.tech_subscriptions
  drop constraint if exists tech_subscriptions_source_check;
alter table public.tech_subscriptions
  add constraint tech_subscriptions_source_check
  check (source in ('manual', 'spaceproxy', 'proxymarket'));

alter table public.tech_provider_balances
  drop constraint if exists tech_provider_balances_provider_check;
alter table public.tech_provider_balances
  add constraint tech_provider_balances_provider_check
  check (provider in ('serper', 'proxymarket'));

alter table public.tech_provider_balances
  drop constraint if exists tech_provider_balances_unit_check;
alter table public.tech_provider_balances
  add constraint tech_provider_balances_unit_check
  check (unit in ('credits', 'RUB'));
