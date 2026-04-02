-- Crypto payment scanner jobs with server-side persistence and resume support.

create table if not exists public.crypto_payment_jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  file_name     text not null default '',
  status        text not null default 'pending'
                check (status in ('pending','running','completed','stopped','error')),
  items         jsonb not null default '[]'::jsonb,   -- all items to scan [{companyName, website}]
  matches       jsonb not null default '[]'::jsonb,   -- found matches [{companyName, website, paymentSystem}]
  checked_count integer not null default 0,
  total_count   integer not null default 0,
  error_message text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- RLS
alter table public.crypto_payment_jobs enable row level security;

create policy "Users can view own crypto_payment_jobs"
  on public.crypto_payment_jobs for select
  using (auth.uid() = user_id);

create policy "Users can insert own crypto_payment_jobs"
  on public.crypto_payment_jobs for insert
  with check (auth.uid() = user_id);

-- Service role can do everything (worker needs update access)
create policy "Service role full access crypto_payment_jobs"
  on public.crypto_payment_jobs for all
  using (auth.role() = 'service_role');

-- Index for worker polling
create index if not exists idx_crypto_payment_jobs_status
  on public.crypto_payment_jobs (status)
  where status in ('pending', 'running');
