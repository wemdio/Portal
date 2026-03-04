create table if not exists public.tg_bot_chats (
  chat_id bigint primary key,
  title text not null default '',
  chat_type text not null default 'group',
  last_message_id bigint,
  updated_at timestamptz not null default now()
);

create index if not exists tg_bot_chats_updated_idx
  on public.tg_bot_chats (updated_at desc);
