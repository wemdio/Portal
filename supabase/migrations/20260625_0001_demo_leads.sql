-- Leads captured by the public landing demo-gate (имя + почта обязательны,
-- телефон опционально) before redirecting the visitor into the read-only /demo.
-- Written ONLY by the public /api/demo-lead route via the service-role client;
-- never read or written by client/authenticated users.

create table if not exists public.demo_leads (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text not null,
  phone       text,
  referrer    text,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists demo_leads_created_at_idx
  on public.demo_leads (created_at desc);

-- No client access: RLS on with no policies → only the service role (which
-- bypasses RLS) can read/write. Matches how other ops-only tables are locked.
alter table public.demo_leads enable row level security;
