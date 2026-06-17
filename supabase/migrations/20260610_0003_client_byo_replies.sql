-- BYO mailbox: входящие ответы, прочитанные по IMAP с подключённых ящиков клиента.
-- Воркер byoReplies опрашивает IMAP, складывает новые письма сюда и пытается
-- сопоставить отправителя с лидом, которому мы писали (matched_to_email).

create table if not exists public.client_byo_replies (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null references public.profiles(id) on delete cascade,
  mailbox_id uuid not null references public.client_mailbox_accounts(id) on delete cascade,
  uid bigint not null,                 -- IMAP UID в INBOX ящика
  from_email text,
  from_name text,
  subject text,
  body text,
  message_id text,
  in_reply_to text,
  matched_to_email text,               -- лид, которому мы писали (если ответ распознан)
  received_at timestamptz,
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  unique (mailbox_id, uid)
);

create index if not exists idx_client_byo_replies_user
  on public.client_byo_replies (client_user_id, received_at desc);

alter table public.client_byo_replies enable row level security;

drop policy if exists "clients read own byo replies" on public.client_byo_replies;
create policy "clients read own byo replies"
  on public.client_byo_replies for select to authenticated
  using (client_user_id = auth.uid());

drop policy if exists "service role full access byo replies" on public.client_byo_replies;
create policy "service role full access byo replies"
  on public.client_byo_replies for all to service_role
  using (true) with check (true);

grant all on public.client_byo_replies to service_role;
grant select on public.client_byo_replies to authenticated;

-- IMAP-курсор на ящике: с какого UID продолжать, проверка uidvalidity, когда проверяли.
alter table public.client_mailbox_accounts
  add column if not exists imap_last_uid bigint not null default 0,
  add column if not exists imap_uidvalidity bigint,
  add column if not exists imap_checked_at timestamptz;

comment on table public.client_byo_replies is
  'Incoming replies read via IMAP from client BYO mailboxes by the byoReplies worker.';
