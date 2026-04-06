-- Add last_activity_at to rdp_sessions for inactivity timeout (30 min).
-- The column is updated via heartbeat from the frontend while the user is active.
-- The worker uses it to auto-end stale sessions (e.g. closed tab / browser crash).

alter table public.rdp_sessions
  add column if not exists last_activity_at timestamp with time zone not null default now();

create index if not exists idx_rdp_sessions_last_activity
  on public.rdp_sessions(last_activity_at)
  where status = 'active';
