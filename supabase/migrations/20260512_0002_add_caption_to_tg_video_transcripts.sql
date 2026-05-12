alter table public.tg_video_transcripts
  add column if not exists caption text;
