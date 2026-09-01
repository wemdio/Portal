-- Latest provider balances shown above the tech calendar.

create table if not exists public.tech_provider_balances (
  provider text primary key
    check (provider in ('serper')),
  label text not null,
  balance numeric(14, 2),
  unit text not null default 'credits'
    check (unit in ('credits')),
  synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tech_provider_balances enable row level security;

grant all on public.tech_provider_balances to service_role;

drop trigger if exists trg_tech_provider_balances_updated_at on public.tech_provider_balances;
create trigger trg_tech_provider_balances_updated_at
  before update on public.tech_provider_balances
  for each row execute function public.tech_subscriptions_touch_updated_at();
