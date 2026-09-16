-- Инструмент «Рассылка»: собственная отправка писем с подключённых ящиков
-- провайдера (Maildoso и подобные) вместо отправки через Instantly.
--
-- Границы: портал НЕ создаёт ящики и домены, не занимается прогревом. Он
-- подключает готовые ящики из выгрузки провайдера, хранит базу получателей,
-- ведёт цепочку писем и читает ответы. Физическая доставка — через SMTP
-- провайдера ящика, своего MTA нет.
--
-- Таблицы служебные: доступ только service_role (все чтения/записи идут через
-- API-роуты инструмента с проверкой доступа). Клиентского доступа нет.

-- ── Ящики ────────────────────────────────────────────────────────────────────
create table if not exists public.sender_mailboxes (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'maildoso'
    check (provider in ('maildoso', 'zapmail', 'google', 'custom')),
  email text not null,
  display_name text,
  username text not null,
  smtp_host text not null,
  smtp_port int not null default 587,
  -- Явный режим TLS вместо boolean: 465 = implicit_tls, 587 = starttls.
  -- Один boolean не давал понятной диагностики и обязательного requireTLS.
  smtp_tls_mode text not null default 'starttls'
    check (smtp_tls_mode in ('implicit_tls', 'starttls')),
  imap_host text,
  imap_port int not null default 993,
  -- sealed via lib/byoMailbox/credentials.sealMailboxSecret (AES-256-GCM)
  secret_encrypted text not null,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'failed', 'disabled')),
  -- Лимиты провайдера, не универсальные: Maildoso рекомендует ~15 писем/день
  -- кампаний на ящик и общий потолок ~100/день с учётом прогрева и ответов.
  daily_campaign_limit int not null default 15,
  daily_total_limit int not null default 100,
  last_verified_at timestamptz,
  last_error text,
  last_send_at timestamptz,
  imap_last_uid bigint,
  imap_uidvalidity text,
  imap_checked_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email)
);

create index if not exists idx_sender_mailboxes_status
  on public.sender_mailboxes (status);
-- опрос входящих: самый давно проверенный ящик первым
create index if not exists idx_sender_mailboxes_imap_checked
  on public.sender_mailboxes (imap_checked_at nulls first)
  where status = 'verified';

-- ── Кампании ─────────────────────────────────────────────────────────────────
create table if not exists public.sender_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft'
    check (status in ('draft', 'running', 'paused', 'done')),
  timezone text not null default 'Europe/Moscow',
  -- Окно отправки в часах локального времени кампании и разрешённые дни недели
  -- (1 = понедельник … 7 = воскресенье): холодная рассылка вне рабочих часов
  -- бьёт по репутации и по ответам.
  send_hour_from int not null default 9 check (send_hour_from between 0 and 23),
  send_hour_to int not null default 18 check (send_hour_to between 1 and 24),
  send_weekdays int[] not null default '{1,2,3,4,5}',
  -- Пауза между письмами одного ящика: базовая + случайная добавка, чтобы
  -- отправка не выглядела машинной пачкой.
  gap_seconds int not null default 180 check (gap_seconds >= 0),
  gap_jitter_seconds int not null default 120 check (gap_jitter_seconds >= 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  check (send_hour_to > send_hour_from)
);

create index if not exists idx_sender_campaigns_status
  on public.sender_campaigns (status, created_at desc);

-- Пул ящиков кампании: лид закрепляется за одним ящиком на всю цепочку.
create table if not exists public.sender_campaign_mailboxes (
  campaign_id uuid not null references public.sender_campaigns(id) on delete cascade,
  mailbox_id uuid not null references public.sender_mailboxes(id) on delete cascade,
  primary key (campaign_id, mailbox_id)
);

-- ── Шаги цепочки ─────────────────────────────────────────────────────────────
create table if not exists public.sender_campaign_steps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.sender_campaigns(id) on delete cascade,
  step_no int not null check (step_no >= 1),
  -- Задержка от предыдущего шага; у первого письма 0.
  delay_days int not null default 0 check (delay_days >= 0),
  -- Пустая тема у follow-up = ответ в той же переписке (Re: к первому письму).
  subject text not null default '',
  body text not null,
  created_at timestamptz not null default now(),
  unique (campaign_id, step_no)
);

-- ── Получатели ───────────────────────────────────────────────────────────────
create table if not exists public.sender_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.sender_campaigns(id) on delete cascade,
  email text not null,
  name text,
  -- Произвольные колонки загруженной базы для подстановки в текст письма.
  vars jsonb not null default '{}'::jsonb,
  status text not null default 'active'
    check (status in ('active', 'replied', 'bounced', 'unsubscribed', 'finished', 'stopped')),
  -- Закрепление за ящиком: вся переписка с лидом идёт с одного адреса.
  mailbox_id uuid references public.sender_mailboxes(id) on delete set null,
  last_step_sent int not null default 0,
  next_step_at timestamptz,
  replied_at timestamptz,
  -- Message-ID первого письма: follow-up уходят в ту же переписку.
  thread_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, email)
);

-- планировщик: кому пора слать следующий шаг
create index if not exists idx_sender_recipients_due
  on public.sender_recipients (next_step_at)
  where status = 'active';
create index if not exists idx_sender_recipients_campaign
  on public.sender_recipients (campaign_id, status);

-- ── Очередь исходящих ────────────────────────────────────────────────────────
create table if not exists public.sender_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.sender_campaigns(id) on delete cascade,
  recipient_id uuid not null references public.sender_recipients(id) on delete cascade,
  mailbox_id uuid not null references public.sender_mailboxes(id) on delete cascade,
  step_no int not null,
  to_email text not null,
  subject text not null,
  body text not null,
  -- Message-ID генерируется ДО отправки и сохраняется: без него нельзя
  -- надёжно связать ответ с письмом и оборвать цепочку.
  message_id text not null,
  in_reply_to text,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'sending', 'sent', 'failed', 'canceled')),
  scheduled_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  unique (recipient_id, step_no)
);

-- дренаж очереди воркером
create index if not exists idx_sender_messages_drain
  on public.sender_messages (scheduled_at)
  where status = 'scheduled';
-- дневной лимит по ящику
create index if not exists idx_sender_messages_mailbox_sent
  on public.sender_messages (mailbox_id, sent_at)
  where status = 'sent';
create index if not exists idx_sender_messages_campaign
  on public.sender_messages (campaign_id, status);

-- ── Входящие ответы ──────────────────────────────────────────────────────────
create table if not exists public.sender_replies (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references public.sender_mailboxes(id) on delete cascade,
  uid bigint not null,
  from_email text,
  from_name text,
  subject text,
  body text,
  message_id text,
  in_reply_to text,
  -- Ответ живого человека надо отличать от автоответа, отбойника и прогрева:
  -- только первый оправдывает остановку цепочки и внимание оператора.
  kind text not null default 'unknown'
    check (kind in ('human', 'auto_reply', 'bounce', 'warmup', 'unknown')),
  recipient_id uuid references public.sender_recipients(id) on delete set null,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  unique (mailbox_id, uid)
);

create index if not exists idx_sender_replies_recent
  on public.sender_replies (created_at desc);

-- ── Стоп-лист ────────────────────────────────────────────────────────────────
create table if not exists public.sender_suppressions (
  email text primary key,
  reason text not null default 'manual'
    check (reason in ('hard_bounce', 'unsubscribe', 'manual', 'complaint')),
  note text,
  created_at timestamptz not null default now()
);

-- ── Атомарный claim очереди ──────────────────────────────────────────────────
-- FOR UPDATE SKIP LOCKED: параллельные воркеры (сейчас один сервер, дальше
-- несколько) никогда не заберут одну строку дважды. Строки, зависшие в
-- 'sending' дольше p_stale_after_seconds (воркер упал между claim и отправкой),
-- возвращаются в оборот, иначе письмо потерялось бы навсегда.
create or replace function public.claim_sender_messages(
  p_limit integer,
  p_stale_after_seconds integer default 600
)
returns setof public.sender_messages
language plpgsql
as $$
begin
  return query
  with picked as (
    select id
      from public.sender_messages
     where (status = 'scheduled' and scheduled_at <= now())
        or (status = 'sending' and claimed_at < now() - make_interval(secs => p_stale_after_seconds))
     order by scheduled_at
     limit p_limit
     for update skip locked
  )
  update public.sender_messages m
     set status = 'sending',
         claimed_at = now()
    from picked
   where m.id = picked.id
  returning m.*;
end;
$$;

comment on function public.claim_sender_messages is
  'Atomically claims due sender_messages rows (FOR UPDATE SKIP LOCKED) so concurrent sender workers never send the same email twice; also reclaims rows stuck in sending past p_stale_after_seconds.';

-- ── Доступ ───────────────────────────────────────────────────────────────────
-- Служебные таблицы внутреннего инструмента: только service_role.
-- Пользователи работают через API-роуты /api/tools/sender/** с проверкой доступа.
alter table public.sender_mailboxes enable row level security;
alter table public.sender_campaigns enable row level security;
alter table public.sender_campaign_mailboxes enable row level security;
alter table public.sender_campaign_steps enable row level security;
alter table public.sender_recipients enable row level security;
alter table public.sender_messages enable row level security;
alter table public.sender_replies enable row level security;
alter table public.sender_suppressions enable row level security;

grant all on public.sender_mailboxes to service_role;
grant all on public.sender_campaigns to service_role;
grant all on public.sender_campaign_mailboxes to service_role;
grant all on public.sender_campaign_steps to service_role;
grant all on public.sender_recipients to service_role;
grant all on public.sender_messages to service_role;
grant all on public.sender_replies to service_role;
grant all on public.sender_suppressions to service_role;

comment on table public.sender_mailboxes is
  'Mailboxes connected from a provider export (Maildoso etc.) for our own sending engine. Secrets encrypted at rest; the portal never creates mailboxes or warms them up.';
comment on table public.sender_messages is
  'Outgoing queue of the sender tool. Drained by the sender worker via claim_sender_messages(), respecting per-mailbox daily limits and campaign send windows.';
comment on column public.sender_recipients.mailbox_id is
  'Sticky sender: the whole follow-up chain for a lead goes from one mailbox.';
