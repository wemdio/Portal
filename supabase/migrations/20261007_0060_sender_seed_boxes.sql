-- «Рассылка»: контрольные ящики — входящие или спам (07.10.2026).
-- Спека: docs/superpowers/specs/2026-10-07-sender-seed-inbox-placement-design.md
--
-- Свои ящики Яндекс, Gmail и Mail.ru. Раз в рабочий день каждый ящик идущих
-- рассылок шлёт на них по нейтральному письму — одно на сервис, — а портал
-- заходит в контрольный ящик по IMAP и смотрит, в какой папке письмо. Из этого
-- считается health score ящика: доля писем во «Входящих» за 7 дней.
--
-- Ежедневная отправка выключена до команды (SENDER_SEED_PROBES_ENABLED=1):
-- сначала подключаем купленные ящики и проверяем вход.

create table if not exists public.sender_seed_boxes (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('yandex', 'gmail', 'mailru')),
  email text not null,
  imap_host text not null,
  imap_port int not null default 993 check (imap_port between 1 and 65535),
  imap_user text not null,
  -- Пароль приложения / пароль IMAP, запечатан sealMailboxSecret
  -- (lib/byoMailbox/credentials). Наружу не отдаётся.
  secret_encrypted text not null,
  enabled boolean not null default true,
  -- pending: ещё не проверяли; ok: вход есть и папка спама найдена;
  -- failed: причина в last_error, в пробы ящик не берётся.
  status text not null default 'pending' check (status in ('pending', 'ok', 'failed')),
  last_error text,
  checked_at timestamptz,
  -- Папка спама, найденная при проверке: у сервисов она называется по-разному.
  junk_folder text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_sender_seed_boxes_email
  on public.sender_seed_boxes (lower(email));

alter table public.sender_seed_boxes enable row level security;
grant all on public.sender_seed_boxes to service_role;

create table if not exists public.sender_seed_probes (
  id uuid primary key default gen_random_uuid(),
  -- День проверки по Москве: одна проба на ящик и сервис в день.
  day date not null,
  mailbox_id uuid not null references public.sender_mailboxes(id) on delete cascade,
  -- Контрольный ящик удалили — история пробы остаётся для health score.
  seed_box_id uuid references public.sender_seed_boxes(id) on delete set null,
  provider text not null check (provider in ('yandex', 'gmail', 'mailru')),
  subject text not null,
  message_id text,
  scheduled_at timestamptz not null,
  sent_at timestamptz,
  -- planned → sent → inbox | spam | missing; send_failed — SMTP отказал;
  -- check_failed — не вошли в контрольный ящик: в health score не считается.
  status text not null default 'planned'
    check (status in ('planned', 'sent', 'inbox', 'spam', 'missing', 'send_failed', 'check_failed')),
  folder text,
  checked_at timestamptz,
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (day, mailbox_id, provider)
);

create index if not exists idx_sender_seed_probes_due
  on public.sender_seed_probes (status, scheduled_at);
create index if not exists idx_sender_seed_probes_mailbox_day
  on public.sender_seed_probes (mailbox_id, day desc);
create index if not exists idx_sender_seed_probes_seed_day
  on public.sender_seed_probes (seed_box_id, day desc);

alter table public.sender_seed_probes enable row level security;
grant all on public.sender_seed_probes to service_role;

comment on table public.sender_seed_boxes is
  'Control (seed) inboxes at Yandex/Gmail/Mail.ru: sender mailboxes send a daily neutral probe here and the portal checks via IMAP whether it landed in Inbox or Spam.';
comment on table public.sender_seed_probes is
  'Daily inbox-placement probes: one per sender mailbox and provider per Moscow day; inbox/spam/missing feed the mailbox health score.';
