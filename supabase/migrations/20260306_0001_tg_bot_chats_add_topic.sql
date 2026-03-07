alter table public.tg_bot_chats
  add column if not exists is_forum boolean not null default false,
  add column if not exists topic_id bigint,
  add column if not exists topic_name text;

comment on column public.tg_bot_chats.is_forum is 'True if the chat is a supergroup with forum topics enabled';
comment on column public.tg_bot_chats.topic_id is 'message_thread_id of the selected topic (null = all topics / General)';
comment on column public.tg_bot_chats.topic_name is 'Human-readable name of the selected topic';

drop index if exists tg_bot_chats_chat_topic_idx;
create unique index tg_bot_chats_chat_topic_idx
  on public.tg_bot_chats (chat_id, coalesce(topic_id, 0));
