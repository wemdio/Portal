-- Задача 4.1 хендоффа фич: ручной ответ лиду из портала.
--
-- Произвольное письмо не ложится в sender_messages: там step_no not null и
-- уникальность (recipient_id, step_no) — таблица рассчитана строго на шаги
-- цепочки. Ручной ответ живёт отдельно и отправляется тем же воркером сендера
-- (SMTP ходит только с изолированного sender-хоста, не из API-процесса).

create table if not exists public.sender_manual_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.sender_campaigns(id) on delete cascade,
  recipient_id uuid not null references public.sender_recipients(id) on delete cascade,
  -- Sticky sender: ответ уходит с того же ящика, что начал переписку.
  mailbox_id uuid not null references public.sender_mailboxes(id) on delete cascade,
  to_email text not null,
  subject text not null default '',
  body text not null,
  message_id text not null,
  in_reply_to text,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'failed')),
  error text,
  sent_at timestamptz,
  attempts int not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sender_manual_messages_drain
  on public.sender_manual_messages (status, created_at);

alter table public.sender_manual_messages enable row level security;

grant all on public.sender_manual_messages to service_role;

-- Атомарный claim по образцу claim_sender_messages: воркер один, но паттерн
-- единый, и при размножении реплик он же спасёт от двойной отправки ответа.
create or replace function public.claim_sender_manual_messages(
  p_limit integer default 5,
  p_stale_after_seconds integer default 600
)
returns setof public.sender_manual_messages
language plpgsql
as $$
begin
  return query
  with picked as (
    select id
      from public.sender_manual_messages
     where (status = 'queued')
        or (status = 'sending' and updated_at < now() - make_interval(secs => p_stale_after_seconds))
     order by created_at
     limit p_limit
     for update skip locked
  )
  update public.sender_manual_messages m
     set status = 'sending',
         updated_at = now()
    from picked
   where m.id = picked.id
  returning m.*;
end;
$$;

comment on table public.sender_manual_messages is
  'Operator replies sent from the portal thread view: queued via API, drained by the sender worker from the sticky mailbox with In-Reply-To into the same thread.';
