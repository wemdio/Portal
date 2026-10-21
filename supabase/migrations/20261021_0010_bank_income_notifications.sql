-- Private, durable baseline and delivery journal for bank income alerts.
-- Activation is explicit in worker config; this migration sends nothing.
create table if not exists public.bank_income_notification_state (
  id boolean primary key default true check (id),
  baseline_id bigint not null,
  started_at timestamptz not null default now()
);
alter table public.bank_income_notification_state enable row level security;
revoke all on public.bank_income_notification_state from anon, authenticated;
grant all on public.bank_income_notification_state to service_role;

create table if not exists public.bank_income_notifications (
  bank_transaction_id bigint primary key references public.bank_transactions(id),
  chat_id bigint not null,
  thread_id integer not null check (thread_id > 0),
  status text not null default 'pending'
    check (status in ('pending','sending','sent','failed','unknown','skipped')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  message_id bigint,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists bank_income_notifications_due_idx
  on public.bank_income_notifications(next_attempt_at) where status = 'pending';
alter table public.bank_income_notifications enable row level security;
revoke all on public.bank_income_notifications from anon, authenticated;
grant all on public.bank_income_notifications to service_role;
