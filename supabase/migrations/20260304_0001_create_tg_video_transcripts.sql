create table if not exists public.tg_video_transcripts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tg_chat_id bigint not null,
  tg_message_id bigint not null,
  tg_sender_id bigint not null,
  sender_name text not null,
  filename text not null,
  file_size_bytes bigint,
  duration_seconds integer,
  text text not null default '',
  length integer not null default 0,
  status text not null default 'completed',
  error_text text
);

create index if not exists tg_video_transcripts_sender_idx
  on public.tg_video_transcripts (sender_name, created_at desc);

create index if not exists tg_video_transcripts_created_idx
  on public.tg_video_transcripts (created_at desc);
