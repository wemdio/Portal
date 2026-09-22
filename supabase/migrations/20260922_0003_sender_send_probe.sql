-- Проверочная отправка с разбором заголовков (задача 5.9 хендоффа масштаба).
--
-- Сендер и Instantly пишут в БД то, что ОТПРАВИЛИ, а не то, что ДОСТАВИЛОСЬ:
-- переписывание заголовков на стороне провайдера (доменная ротация Maildoso)
-- было невидимо и ломало цепочки месяцами. Проба шлёт письмо с ящика на
-- внешний контрольный адрес, читает его там же и сравнивает заголовки.

create table if not exists public.sender_send_probes (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references public.sender_mailboxes(id) on delete cascade,
  created_by uuid,
  -- pending: ждёт отправки; sent: письмо ушло, ждём доставки на контрольный
  -- адрес; done/failed: финал, результат в result.
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'done', 'failed')),
  sent_message_id text,
  sent_from text,
  sent_at timestamptz,
  received_at timestamptz,
  -- [{check, expected, actual, ok, note}] — сравнение построчно, читается UI.
  result jsonb not null default '[]'::jsonb,
  -- true = все проверки прошли, ключи заголовков не тронуты.
  passed boolean,
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sender_send_probes_mailbox
  on public.sender_send_probes (mailbox_id, created_at desc);

alter table public.sender_send_probes enable row level security;

grant all on public.sender_send_probes to service_role;

comment on table public.sender_send_probes is
  'Probe sends from a sender mailbox to an external control address: compares delivered headers (From/Return-Path/DKIM/Message-ID) with what the portal sent, so provider-side rewriting (domain rotation) becomes visible.';
