create table if not exists public.tg_scan_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  tg_chat_id bigint not null,
  topic_id bigint,
  video_count integer not null,
  user_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending','running','completed','failed','stopped')),
  scanned integer not null default 0,
  videos_found integer not null default 0,
  completed integer not null default 0,
  errors integer not null default 0,
  videos jsonb not null default '[]'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  error_message text
);

create index if not exists tg_scan_jobs_chat_status_idx
  on public.tg_scan_jobs (tg_chat_id, status);
