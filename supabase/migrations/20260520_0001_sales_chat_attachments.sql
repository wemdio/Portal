-- Sales chat analyzer: downloaded Telegram document attachments stored in MAIN S3.

create table if not exists public.sales_chat_message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references public.sales_chat_messages(id) on delete cascade,
  account_id uuid references public.sales_chat_accounts(id) on delete set null,
  dialog_id uuid not null references public.sales_chat_dialogs(id) on delete cascade,

  tg_message_id bigint not null,
  tg_peer_id bigint not null,

  media_type text not null,
  file_name text,
  mime_type text,
  file_size_bytes bigint,

  s3_bucket text,
  s3_key text,

  status text not null default 'uploaded'
    check (status in ('uploaded', 'skipped', 'error')),
  error_message text,

  created_at timestamptz not null default now(),
  uploaded_at timestamptz
);

create unique index if not exists idx_sales_chat_message_attachments_message_unique
  on public.sales_chat_message_attachments(dialog_id, tg_message_id);
create index if not exists idx_sales_chat_message_attachments_dialog
  on public.sales_chat_message_attachments(dialog_id, tg_message_id);

alter table public.sales_chat_message_attachments enable row level security;

grant all on public.sales_chat_message_attachments to service_role;
grant select, insert, update on public.sales_chat_message_attachments to authenticated;
