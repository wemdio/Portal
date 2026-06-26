-- RPC for the chat-filter UI on /tools/tg-transcribe.
-- Replaces an unbounded `select tg_chat_id, topic_id from tg_video_transcripts`
-- that silently truncates at PostgREST's db-max-rows cap (~1000) once the
-- table grows. Aggregates server-side so the response is O(chats × topics).
--
-- topic_id is coalesced so legacy NULL (pre-2026-06-25) and the new 0
-- sentinel collapse into the same chat-level bucket — matches the convention
-- the inserts use today (msg.message_thread_id ?? 0).

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
  group by t.tg_chat_id, coalesce(t.topic_id, 0)
$$;

grant execute on function public.tg_transcribed_chat_topic_counts() to anon, authenticated, service_role;

notify pgrst, 'reload schema';
