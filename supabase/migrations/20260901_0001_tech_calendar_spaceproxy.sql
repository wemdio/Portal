-- SpaceProxy auto-sync for the tech calendar.
--
-- Synced proxy rows stay in the calendar table instead of being deleted:
-- an expired proxy can be hidden from the default view and returned later.

alter table public.tech_subscriptions
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'spaceproxy')),
  add column if not exists external_key text,
  add column if not exists quantity integer not null default 1
    check (quantity > 0),
  add column if not exists provider_status text,
  add column if not exists synced_at timestamptz,
  add column if not exists is_hidden boolean not null default false,
  add column if not exists hidden_at timestamptz;

alter table public.tech_subscriptions
  drop constraint if exists tech_subscriptions_external_key_check;
alter table public.tech_subscriptions
  add constraint tech_subscriptions_external_key_check
  check (
    (source = 'manual' and external_key is null)
    or (source <> 'manual' and external_key is not null)
  );

create unique index if not exists idx_tech_subscriptions_source_external_key
  on public.tech_subscriptions(source, external_key);

create index if not exists idx_tech_subscriptions_is_hidden
  on public.tech_subscriptions(is_hidden);
