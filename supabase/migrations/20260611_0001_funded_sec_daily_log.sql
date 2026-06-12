-- Idempotency log for the daily SEC Form D poller (scripts/funded/poll-sec-daily.mjs):
-- one row per processed EDGAR accession so re-runs and overlapping date windows
-- never double-count an offering into funded_companies totals.

create table if not exists public.funded_sec_daily_log (
  accession    text primary key,            -- e.g. 0002140137-26-000001
  cik          text,
  filing_date  date,
  processed_at timestamptz not null default now()
);

create index if not exists idx_funded_sec_daily_log_date on public.funded_sec_daily_log (filing_date);

-- Internal ops table: no client access, service_role only (bypasses RLS).
alter table public.funded_sec_daily_log enable row level security;
grant all on public.funded_sec_daily_log to service_role;
