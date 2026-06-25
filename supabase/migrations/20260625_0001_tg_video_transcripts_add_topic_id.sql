-- Add topic_id to tg_video_transcripts so transcripts from forum-group
-- subchats can be filtered by topic. NULL means "unknown / legacy record"
-- (pre-migration data has no topic context). New writes go through the
-- webhook / scan worker and will populate this from msg.message_thread_id
-- (0 when the message is in General or a non-forum chat).

alter table public.tg_video_transcripts
  add column if not exists topic_id bigint;

comment on column public.tg_video_transcripts.topic_id is
  'message_thread_id of the forum topic the video belongs to. 0 = General / non-forum. NULL = legacy record (pre-2026-06-25).';

create index if not exists tg_video_transcripts_chat_topic_idx
  on public.tg_video_transcripts (tg_chat_id, topic_id);

-- Self-hosted PostgREST caches the schema; without this NOTIFY the new
-- column stays invisible until the worker restarts, which surfaces as
-- PGRST204 "column topic_id does not exist" on every insert/select.
notify pgrst, 'reload schema';
