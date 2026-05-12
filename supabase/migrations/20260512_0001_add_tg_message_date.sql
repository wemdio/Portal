alter table public.tg_video_transcripts
  add column if not exists tg_message_date timestamptz;

create index if not exists tg_video_transcripts_message_date_idx
  on public.tg_video_transcripts (tg_message_date desc nulls last);
