-- Chip counts on /tools/tg-transcribe must match what the History list shows.
-- History now displays only status='completed' rows; error rows and the new
-- permanent-skip markers (skipped_no_audio / skipped_no_speech — stickers,
-- muted screen recordings, music-only clips) are bookkeeping, not transcripts,
-- so they shouldn't inflate the per-chat counters either.

create or replace function public.tg_transcribed_chat_topic_counts()
returns table (
  tg_chat_id bigint,
  topic_id bigint,
  cnt bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.tg_chat_id,
    coalesce(t.topic_id, 0) as topic_id,
    count(*) as cnt
  from public.tg_video_transcripts t
  where t.status = 'completed'
  group by t.tg_chat_id, coalesce(t.topic_id, 0)
$$;

grant execute on function public.tg_transcribed_chat_topic_counts() to anon, authenticated, service_role;

notify pgrst, 'reload schema';
