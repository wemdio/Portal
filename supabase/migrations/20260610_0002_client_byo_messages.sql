-- BYO mailbox: очередь/лог исходящих писем кампаний (наш SMTP-движок, не Instantly).
-- Воркер byoSend дренит status='pending' (lib/byoMailbox/sender.processByoSendBatch),
-- соблюдая дневной лимит ящика и паузу между письмами. scheduled_at = не раньше когда слать.

create table if not exists public.client_byo_messages (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null references public.profiles(id) on delete cascade,
  mailbox_id uuid not null references public.client_mailbox_accounts(id) on delete cascade,
  campaign_name text not null default '',
  to_email text not null,
  to_name text,
  subject text not null,
  body text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped', 'canceled')),
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);

-- дренаж очереди воркером
create index if not exists idx_client_byo_messages_drain
  on public.client_byo_messages (scheduled_at)
  where status = 'pending';
-- список кампаний клиента
create index if not exists idx_client_byo_messages_user
  on public.client_byo_messages (client_user_id, created_at desc);
-- подсчёт отправленного за сегодня по ящику (дневной лимит)
create index if not exists idx_client_byo_messages_mailbox_sent
  on public.client_byo_messages (mailbox_id, sent_at)
  where status = 'sent';

alter table public.client_byo_messages enable row level security;

drop policy if exists "clients read own byo messages" on public.client_byo_messages;
create policy "clients read own byo messages"
  on public.client_byo_messages for select to authenticated
  using (client_user_id = auth.uid());

drop policy if exists "service role full access byo messages" on public.client_byo_messages;
create policy "service role full access byo messages"
  on public.client_byo_messages for all to service_role
  using (true) with check (true);

grant all on public.client_byo_messages to service_role;
grant select on public.client_byo_messages to authenticated;

comment on table public.client_byo_messages is
  'Outgoing campaign emails sent via our own SMTP from client BYO mailboxes. Drained by the byoSend worker, respecting per-mailbox daily_limit.';
