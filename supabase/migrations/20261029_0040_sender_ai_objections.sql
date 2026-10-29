-- Работа с возражениями наших RU/EN автоаутричей. Настройки не включаем:
-- новый входящий берётся только после ручного включения ИИ у папки.
alter table public.sender_ai_conversations
  drop constraint if exists sender_ai_conversations_state_check;
alter table public.sender_ai_conversations
  add constraint sender_ai_conversations_state_check
    check (state in ('active','handed_off','no_reply','closed','stopped','failed','review'));

alter table public.sender_ai_conversations
  add column if not exists last_intent text,
  add column if not exists last_objection text,
  add column if not exists objection_turns integer not null default 0 check (objection_turns >= 0),
  add column if not exists used_case_ids text[] not null default '{}';

-- Один оплаченный ход воспроизводится после сбоя, не генерируется заново.
-- Полный текст отправки остаётся также в обычном журнале sender_manual_messages.
create table if not exists public.sender_ai_turns (
  id uuid primary key,
  recipient_id uuid not null references public.sender_ai_conversations(recipient_id) on delete cascade,
  reply_id uuid not null references public.sender_replies(id) on delete cascade,
  mode text not null check (mode in ('reply','reminder')),
  step_json jsonb not null,
  decision text not null,
  created_at timestamptz not null default now()
);
create index if not exists sender_ai_turns_recipient_idx on public.sender_ai_turns(recipient_id,created_at);
alter table public.sender_ai_turns enable row level security;
revoke all on public.sender_ai_turns from anon,authenticated;
grant all on public.sender_ai_turns to service_role;

alter table public.sender_manual_messages
  add column if not exists ai_reply_id uuid references public.sender_replies(id) on delete set null;

create or replace view public.sender_ai_latest_replies as
select distinct on (recipient_id) recipient_id,id,received_at,created_at
from public.sender_replies
where kind='human' and recipient_id is not null
order by recipient_id,coalesce(received_at,created_at) desc,created_at desc,id desc;
revoke all on public.sender_ai_latest_replies from anon,authenticated;
grant select on public.sender_ai_latest_replies to service_role;

-- Не переименовываем отказ в лид ради диалога. Машинные письма, ошибочно
-- помеченные human, движок отдельно закрывает без ответа. Уже занятые/старые
-- строки не забивают первые 20 мест очереди на каждом проходе.
create or replace view public.sender_ai_intake_queue as
select q.reply_id,q.recipient_id,q.campaign_id,q.qualified_at
from public.sender_reply_qualifications q
join public.sender_replies r on r.id=q.reply_id
join public.sender_ai_latest_replies latest on latest.id=r.id
join public.sender_recipients sr on sr.id=q.recipient_id
join public.sender_campaigns c on c.id=q.campaign_id
join public.sender_folders f on f.id=c.folder_id
where f.key in ('auto_ru','auto_en') and f.ai_enabled and f.leads_enabled and f.leads_telegram
  and f.ai_enabled_at is not null and q.qualified_at >= f.ai_enabled_at
  and coalesce(r.received_at,r.created_at) >= f.ai_enabled_at
  and q.status in ('lead','not_lead') and q.tg_sent_at is null and q.tg_attempts < 5
  and r.kind='human' and sr.status not in ('unsubscribed','bounced','stopped')
  and sr.lead_verdict_source is distinct from 'manual'
  and not exists (select 1 from public.sender_ai_conversations a where a.recipient_id=q.recipient_id)
  and not exists (select 1 from public.sender_reply_qualifications sent
    where sent.recipient_id=q.recipient_id and sent.tg_sent_at is not null)
  and not exists (select 1 from public.sender_manual_messages mm
    where mm.recipient_id=q.recipient_id and not mm.by_ai
      and mm.agency_handoff_id is null and mm.handoff is null);
revoke all on public.sender_ai_intake_queue from anon,authenticated;
grant select on public.sender_ai_intake_queue to service_role;
