-- polza-reports tool: Coldy credentials (encrypted) and report job history.
--
-- Two tables:
--   polza_coldy_credentials — one row per user, holding the AES-256-GCM-sealed
--     Coldy login. We never store plaintext; the cipher key (POLZA_CRED_KEY)
--     lives only in the portal container's environment.
--   polza_report_jobs — audit/history of each report run, plus the S3 key of
--     the rendered xlsx so users can re-download from the history block.

-- ── Credentials ──────────────────────────────────────────────────────────────

create table if not exists public.polza_coldy_credentials (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  -- AES-256-GCM(JSON{email,password,url}) — see app/src/lib/cryptoGcm.ts
  sealed_credentials text not null,
  -- Display-only metadata so the UI can show "you saved kuladmed@…" without
  -- decrypting. We do NOT store the password masked here.
  email_hint text,
  url text not null default 'https://app.coldy.ai',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.polza_coldy_credentials enable row level security;

drop policy if exists polza_coldy_credentials_select_own on public.polza_coldy_credentials;
create policy polza_coldy_credentials_select_own
  on public.polza_coldy_credentials
  for select
  using (auth.uid() = user_id);

drop policy if exists polza_coldy_credentials_insert_own on public.polza_coldy_credentials;
create policy polza_coldy_credentials_insert_own
  on public.polza_coldy_credentials
  for insert
  with check (auth.uid() = user_id);

drop policy if exists polza_coldy_credentials_update_own on public.polza_coldy_credentials;
create policy polza_coldy_credentials_update_own
  on public.polza_coldy_credentials
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists polza_coldy_credentials_delete_own on public.polza_coldy_credentials;
create policy polza_coldy_credentials_delete_own
  on public.polza_coldy_credentials
  for delete
  using (auth.uid() = user_id);


-- ── Jobs ─────────────────────────────────────────────────────────────────────

create table if not exists public.polza_report_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source text not null check (source in ('coldy', 'trigga')),
  status text not null check (status in ('pending', 'running', 'completed', 'failed')),
  -- Coldy: detailed report (per-letter analytics) toggle.
  detailed boolean not null default true,
  -- Excel column toggles (Trigga skips both by default).
  include_created boolean not null default true,
  include_base_left boolean not null default true,
  -- Latest streaming progress event from the microservice, e.g.
  --   {"phase": "analytics", "current": 3, "total": 7, "campaign_name": "…"}
  progress jsonb not null default '{}'::jsonb,
  -- S3 key (in MAIN_S3_BUCKET) of the rendered xlsx, set when status='completed'.
  result_xlsx_path text,
  result_filename text,
  campaigns_count integer,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists idx_polza_report_jobs_user_created
  on public.polza_report_jobs (user_id, created_at desc);

alter table public.polza_report_jobs enable row level security;

drop policy if exists polza_report_jobs_select_own on public.polza_report_jobs;
create policy polza_report_jobs_select_own
  on public.polza_report_jobs
  for select
  using (auth.uid() = user_id);

drop policy if exists polza_report_jobs_insert_own on public.polza_report_jobs;
create policy polza_report_jobs_insert_own
  on public.polza_report_jobs
  for insert
  with check (auth.uid() = user_id);

drop policy if exists polza_report_jobs_update_own on public.polza_report_jobs;
create policy polza_report_jobs_update_own
  on public.polza_report_jobs
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists polza_report_jobs_delete_own on public.polza_report_jobs;
create policy polza_report_jobs_delete_own
  on public.polza_report_jobs
  for delete
  using (auth.uid() = user_id);


-- ── Trigger: keep updated_at fresh on credential changes ────────────────────

create or replace function public.polza_coldy_credentials_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists polza_coldy_credentials_touch_updated_at
  on public.polza_coldy_credentials;
create trigger polza_coldy_credentials_touch_updated_at
  before update on public.polza_coldy_credentials
  for each row
  execute function public.polza_coldy_credentials_touch_updated_at();
