-- CIS Lead Finder: raw file rows, import jobs, companies, phone identities, and company contacts

-----------------------------
-- lead_import_jobs
-----------------------------

create table if not exists public.lead_import_jobs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  status          text not null check (status in ('pending','running','completed','failed')),
  source_filename text not null,
  source_label    text,
  total_rows      integer not null default 0,
  processed_rows  integer not null default 0,
  error_message   text,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz
);

create index if not exists idx_lead_import_jobs_user_created_at
  on public.lead_import_jobs(user_id, created_at desc);

-----------------------------
-- companies (generic CIS companies catalog)
-----------------------------

create table if not exists public.companies (
  id               uuid primary key default gen_random_uuid(),
  inn              text unique,
  ogrn             text,
  name             text not null,
  short_name       text,
  brand_name       text,
  region           text,
  city             text,
  okved_main       text,
  employees_range  text,
  site             text,
  phone            text,
  email            text,
  source           text not null default 'manual',
  source_confidence numeric not null default 1.0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_companies_inn on public.companies(inn);
create index if not exists idx_companies_name_region on public.companies(name, region);

-----------------------------
-- raw_leads (rows from uploaded files)
-----------------------------

create table if not exists public.raw_leads (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  import_job_id    uuid not null references public.lead_import_jobs(id) on delete cascade,
  row_index        integer not null,

  raw_inn          text,
  raw_company_name text,
  raw_site         text,
  raw_city         text,
  raw_region       text,
  raw_phone        text,
  raw_email        text,
  raw_contact_name text,
  raw_position     text,
  raw_notes        text,
  raw_payload      jsonb not null default '{}'::jsonb,

  company_id       uuid references public.companies(id) on delete set null,

  created_at       timestamptz not null default now()
);

create index if not exists idx_raw_leads_job_row on public.raw_leads(import_job_id, row_index);
create index if not exists idx_raw_leads_user_job on public.raw_leads(user_id, import_job_id);
create index if not exists idx_raw_leads_company on public.raw_leads(company_id);

-----------------------------
-- phone_identities (phone -> Telegram identity and metadata)
-----------------------------

create table if not exists public.phone_identities (
  id              uuid primary key default gen_random_uuid(),
  phone_normalized text not null,
  tg_user_id      bigint,
  tg_username     text,
  first_name      text,
  last_name       text,
  about           text,
  photo_url       text,
  last_seen_at    timestamptz,
  source          text not null default 'mtproto',
  checked_at      timestamptz not null default now(),
  check_status    text not null default 'found' check (check_status in ('found','not_found','error')),
  error_message   text
);

create unique index if not exists idx_phone_identities_phone
  on public.phone_identities(phone_normalized);

-----------------------------
-- company_contacts (aggregated contacts per company)
-----------------------------

create table if not exists public.company_contacts (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  company_id           uuid not null references public.companies(id) on delete cascade,

  source               text not null default 'manual',
  full_name            text not null,
  first_name           text,
  last_name            text,
  title                text,
  role_guess           text,

  channel_phone        text,
  channel_tg_username  text,
  channel_email        text,

  source_url           text,
  score                integer not null default 0,
  confidence           numeric not null default 1.0,

  created_at           timestamptz not null default now()
);

create index if not exists idx_company_contacts_company_score
  on public.company_contacts(company_id, score desc);

create index if not exists idx_company_contacts_user_company
  on public.company_contacts(user_id, company_id);

-----------------------------
-- Row Level Security
-----------------------------

alter table public.lead_import_jobs enable row level security;
alter table public.raw_leads enable row level security;
alter table public.company_contacts enable row level security;

-- lead_import_jobs: own rows only
drop policy if exists lead_import_jobs_select_own on public.lead_import_jobs;
create policy lead_import_jobs_select_own
  on public.lead_import_jobs
  for select
  using (auth.uid() = user_id);

drop policy if exists lead_import_jobs_insert_own on public.lead_import_jobs;
create policy lead_import_jobs_insert_own
  on public.lead_import_jobs
  for insert
  with check (auth.uid() = user_id);

drop policy if exists lead_import_jobs_update_own on public.lead_import_jobs;
create policy lead_import_jobs_update_own
  on public.lead_import_jobs
  for update
  using (auth.uid() = user_id);

-- raw_leads: via user_id
drop policy if exists raw_leads_select_own on public.raw_leads;
create policy raw_leads_select_own
  on public.raw_leads
  for select
  using (auth.uid() = user_id);

drop policy if exists raw_leads_insert_own on public.raw_leads;
create policy raw_leads_insert_own
  on public.raw_leads
  for insert
  with check (auth.uid() = user_id);

drop policy if exists raw_leads_update_own on public.raw_leads;
create policy raw_leads_update_own
  on public.raw_leads
  for update
  using (auth.uid() = user_id);

-- company_contacts: own rows only (per user_id)
drop policy if exists company_contacts_select_own on public.company_contacts;
create policy company_contacts_select_own
  on public.company_contacts
  for select
  using (auth.uid() = user_id);

drop policy if exists company_contacts_insert_own on public.company_contacts;
create policy company_contacts_insert_own
  on public.company_contacts
  for insert
  with check (auth.uid() = user_id);

drop policy if exists company_contacts_update_own on public.company_contacts;
create policy company_contacts_update_own
  on public.company_contacts
  for update
  using (auth.uid() = user_id);

