create table if not exists public.tg_transcribe_jobs (
  id uuid primary key default gen_random_uuid(),
  tg_chat_id bigint not null,
  tg_message_id bigint not null,
  topic_id bigint,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  payload jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (tg_chat_id, tg_message_id)
);

create index if not exists tg_transcribe_jobs_status_created_idx
  on public.tg_transcribe_jobs (status, created_at);

create index if not exists tg_transcribe_jobs_chat_idx
  on public.tg_transcribe_jobs (tg_chat_id, created_at desc);
