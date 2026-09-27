-- Missing provider thread context must not make webhook drain a hot loop.
-- Additive scheduling metadata only: do not reopen/qualify/replay any event.
alter table public.instantly_webhook_events
  add column if not exists retry_attempts integer not null default 0,
  add column if not exists retry_next_at timestamptz;

create index if not exists idx_instantly_webhook_events_retry_due
  on public.instantly_webhook_events (retry_next_at, created_at)
  where processed = false;

comment on column public.instantly_webhook_events.retry_next_at is
  'Earliest next webhook retry after a transient dependency failure; NULL means immediate eligibility.';
