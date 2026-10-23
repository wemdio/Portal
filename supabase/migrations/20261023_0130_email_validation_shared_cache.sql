-- Shared email validation memory (owner 2026-10-23: «общий кэш результатов и
-- признака „принимает любые адреса“ … даже на пару месяцев»).
--
-- The three SMTP probe IPs returned to Spamhaus CSS a day after delisting:
-- every job probed the same addresses and domains again. Conclusive SMTP
-- verdicts per address and the catch-all flag per domain are kept here and
-- reused by every validation path (constructor, validation queue, auto
-- pipeline, outreach runners); see app/src/lib/emailValidation/sharedCache.ts.
-- Unknown answers are never stored. Service role only, like
-- email_validation_domain_cache. Additive: no existing table changes.

create table if not exists public.email_validation_result_cache (
  email text primary key,
  result text not null check (result in ('ok', 'invalid', 'catch_all')),
  payload jsonb not null,
  checked_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null
);

create index if not exists idx_email_validation_result_cache_expires
  on public.email_validation_result_cache(expires_at);

create table if not exists public.email_validation_catch_all_cache (
  domain text primary key,
  is_catch_all boolean not null,
  checked_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null
);

create index if not exists idx_email_validation_catch_all_cache_expires
  on public.email_validation_catch_all_cache(expires_at);

alter table public.email_validation_result_cache enable row level security;
alter table public.email_validation_catch_all_cache enable row level security;

revoke all on table public.email_validation_result_cache from anon, authenticated;
revoke all on table public.email_validation_catch_all_cache from anon, authenticated;

-- The workers read and write through the service role.
grant all on public.email_validation_result_cache to service_role;
grant all on public.email_validation_catch_all_cache to service_role;
