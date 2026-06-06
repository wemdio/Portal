-- BYO mailbox: клиентские почтовые ящики, подключённые САМИМ клиентом для
-- отправки через собственный SMTP (наш движок, без Instantly).
--
-- Безопасность:
--   * пароли приложений хранятся ТОЛЬКО зашифрованными (AES-256-GCM, lib/cryptoGcm
--     через lib/byoMailbox/credentials, env BYO_MAILBOX_CRED_KEY). В открытом виде — никогда.
--   * фича скрыта за флагом user_tool_visibility(tool_id='byo-mailbox'); по умолчанию
--     выключена у всех → существующие клиенты её не видят и не затрагиваются.

create table if not exists public.client_mailbox_accounts (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null references public.profiles(id) on delete cascade,
  email text not null,
  display_name text,
  provider text not null default 'custom'
    check (provider in ('yandex', 'mailru', 'gmail', 'custom')),
  smtp_host text not null,
  smtp_port int not null default 465,
  smtp_secure boolean not null default true,
  imap_host text,
  imap_port int,
  username text not null,
  -- sealed via lib/byoMailbox/credentials.sealMailboxSecret (AES-256-GCM)
  secret_encrypted text not null,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'failed', 'disabled')),
  last_verified_at timestamptz,
  last_error text,
  -- guardrail: верхняя граница писем/день с этого ящика (защита от выжигания репутации)
  daily_limit int not null default 30,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_user_id, email)
);

create index if not exists idx_client_mailbox_accounts_user
  on public.client_mailbox_accounts (client_user_id);

alter table public.client_mailbox_accounts enable row level security;

-- Клиент видит ТОЛЬКО свои ящики. Запись/верификация идут через service role
-- (минует RLS), и в коде всегда фильтруется по client_user_id.
drop policy if exists "clients read own mailboxes" on public.client_mailbox_accounts;
create policy "clients read own mailboxes"
  on public.client_mailbox_accounts for select
  to authenticated
  using (client_user_id = auth.uid());

-- Service role full access (все записи/верификация идут через supabaseAdmin).
drop policy if exists "service role full access" on public.client_mailbox_accounts;
create policy "service role full access"
  on public.client_mailbox_accounts for all
  to service_role
  using (true) with check (true);

-- Явные GRANT (lint: app/tests/migrations/grants.test.ts). Запись — только через
-- service_role; authenticated может лишь SELECT, дополнительно сужённый RLS-политикой выше.
grant all on public.client_mailbox_accounts to service_role;
grant select on public.client_mailbox_accounts to authenticated;

comment on table public.client_mailbox_accounts is
  'Client-owned sending mailboxes (BYO) for our own SMTP engine. Secrets encrypted at rest (lib/byoMailbox/credentials). Feature gated by user_tool_visibility(byo-mailbox), default off.';
comment on column public.client_mailbox_accounts.secret_encrypted is
  'AES-256-GCM sealed {smtpPassword, imapPassword?} — never store plaintext.';
comment on column public.client_mailbox_accounts.daily_limit is
  'Max emails/day from this mailbox. Deliverability guardrail for self-serve clients.';
