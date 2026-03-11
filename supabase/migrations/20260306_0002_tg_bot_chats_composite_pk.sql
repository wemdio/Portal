-- Allow multiple rows per chat (one per topic).
-- Replace single-column PK with a surrogate id and a composite unique constraint.

-- 1. Drop the old primary key on chat_id
alter table public.tg_bot_chats drop constraint tg_bot_chats_pkey;

-- 2. Add surrogate primary key
alter table public.tg_bot_chats
  add column id bigint generated always as identity primary key;

-- 3. Replace NULLs in topic_id with 0 so the unique index works without coalesce
update public.tg_bot_chats set topic_id = 0 where topic_id is null;
alter table public.tg_bot_chats alter column topic_id set default 0;
alter table public.tg_bot_chats alter column topic_id set not null;

-- 4. Drop the old expression-based index and create a plain composite unique index
drop index if exists tg_bot_chats_chat_topic_idx;
create unique index tg_bot_chats_chat_topic_idx
  on public.tg_bot_chats (chat_id, topic_id);
