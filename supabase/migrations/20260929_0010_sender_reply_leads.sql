-- Квалификация ответов «Рассылки» и передача лидов в ТГ-чат
-- (docs/superpowers/specs/2026-09-29-sender-reply-leads-design.md).
--
-- Живой ответ (sender_replies.kind = 'human') оценивает воркер
-- worker-sender-leads на 139 теми же правилами, что ответы Instantly
-- (lib/instantly/leadQualifier.ts qualifyReply). Одна строка оценки на ответ;
-- итог по переписке — в sender_recipients (его можно поправить руками).

-- ── Настройки квалификатора у папки ──────────────────────────────────────────
-- Хранятся в базе, а не в env: вкладка «Квалификация» автоаутрича сохраняет их,
-- и воркер подхватывает на следующем круге — без перезапуска.
alter table public.sender_folders
  add column if not exists lead_criteria text,
  add column if not exists leads_enabled boolean not null default true,
  add column if not exists leads_telegram boolean not null default true;

alter table public.sender_folders
  drop constraint if exists sender_folders_lead_criteria_len;
alter table public.sender_folders
  add constraint sender_folders_lead_criteria_len
  check (lead_criteria is null or char_length(lead_criteria) <= 2000);

comment on column public.sender_folders.lead_criteria is
  'Что считать лидом у рассылок папки (до 2000 символов). Приоритетнее общих правил квалификатора. Пусто — общие правила.';
comment on column public.sender_folders.leads_enabled is
  'Оценивать ли ИИ живые ответы рассылок папки.';
comment on column public.sender_folders.leads_telegram is
  'Слать ли лидов папки в ТГ-чат.';

-- ── Итог по переписке ────────────────────────────────────────────────────────
-- Ручная метка приоритетнее ИИ: новая оценка по той же переписке её не перебивает.
alter table public.sender_recipients
  add column if not exists lead_verdict text,
  add column if not exists lead_verdict_source text,
  add column if not exists lead_verdict_at timestamptz,
  add column if not exists lead_verdict_by uuid;

alter table public.sender_recipients
  drop constraint if exists sender_recipients_lead_verdict_check;
alter table public.sender_recipients
  add constraint sender_recipients_lead_verdict_check
  check (
    (lead_verdict is null or lead_verdict in ('lead', 'not_lead'))
    and (lead_verdict_source is null or lead_verdict_source in ('ai', 'manual'))
  );

-- ── Оценки ответов ───────────────────────────────────────────────────────────
create table if not exists public.sender_reply_qualifications (
  reply_id uuid primary key references public.sender_replies(id) on delete cascade,
  recipient_id uuid not null references public.sender_recipients(id) on delete cascade,
  campaign_id uuid not null references public.sender_campaigns(id) on delete cascade,
  -- pending — в работе или ждёт повтора; skipped — не оцениваем (старый ответ,
  -- квалификация папки выключена); error — ИИ так и не ответил за 5 попыток.
  status text not null default 'pending'
    check (status in ('pending', 'lead', 'not_lead', 'error', 'skipped')),
  ai_reason text,
  interest_signals text[] not null default '{}',
  criteria_used boolean not null default false,
  model text,
  attempts int not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  qualified_at timestamptz,
  tg_sent_at timestamptz,
  tg_message_id bigint,
  tg_attempts int not null default 0,
  tg_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sender_reply_qualifications_pending
  on public.sender_reply_qualifications (next_attempt_at)
  where status = 'pending';
create index if not exists idx_sender_reply_qualifications_campaign
  on public.sender_reply_qualifications (campaign_id, created_at desc);
create index if not exists idx_sender_reply_qualifications_recipient
  on public.sender_reply_qualifications (recipient_id);
-- Доставка в чат: лиды, которые ещё не ушли.
create index if not exists idx_sender_reply_qualifications_tg_due
  on public.sender_reply_qualifications (qualified_at)
  where status = 'lead' and tg_sent_at is null;

alter table public.sender_reply_qualifications enable row level security;
grant all on public.sender_reply_qualifications to service_role;

-- Старые ответы не оцениваем: иначе после выкладки в чат разом ушли бы все
-- лиды за всё время. Отмечаем их «пропущено» — очередь берёт только ответы без
-- строки оценки.
insert into public.sender_reply_qualifications (reply_id, recipient_id, campaign_id, status, last_error)
select p.id, p.recipient_id, r.campaign_id, 'skipped', 'ответ пришёл до запуска квалификации'
from public.sender_replies p
join public.sender_recipients r on r.id = p.recipient_id
where p.kind = 'human'
on conflict (reply_id) do nothing;

-- ── Очередь на оценку ────────────────────────────────────────────────────────
-- Живые ответы с известной перепиской, у которых ещё нет строки оценки.
-- Представление, а не выборка в приложении: «нет строки» через PostgREST иначе
-- не выразить без выкачивания всех ответов.
create or replace view public.sender_lead_queue as
select
  p.id           as reply_id,
  p.recipient_id,
  r.campaign_id,
  p.created_at
from public.sender_replies p
join public.sender_recipients r on r.id = p.recipient_id
where p.kind = 'human'
  and not exists (
    select 1 from public.sender_reply_qualifications q where q.reply_id = p.id
  );

grant select on public.sender_lead_queue to service_role;

-- ── Метка на вкладке «Письма» ────────────────────────────────────────────────
-- Новые колонки — только в конец: create or replace view не умеет вставлять
-- их в середину.
create or replace view public.sender_threads as
select
  r.id                                  as recipient_id,
  r.campaign_id,
  c.name                                as campaign_name,
  r.email                               as recipient_email,
  r.name                                as recipient_name,
  r.status,
  r.replied_at,
  r.mailbox_id,
  mb.email                              as mailbox_email,
  out_msg.sent_count,
  out_msg.last_sent_at,
  coalesce(inc.reply_count, 0)          as reply_count,
  inc.last_reply_at,
  coalesce(inc.has_human_reply, false)  as has_human_reply,
  greatest(
    coalesce(out_msg.last_sent_at, to_timestamp(0)),
    coalesce(inc.last_reply_at, to_timestamp(0))
  )                                     as last_activity_at,
  r.lead_verdict,
  r.lead_verdict_source
from public.sender_recipients r
join public.sender_campaigns c on c.id = r.campaign_id
left join public.sender_mailboxes mb on mb.id = r.mailbox_id
join lateral (
  select
    count(*) filter (where m.status = 'sent') as sent_count,
    max(m.sent_at) filter (where m.status = 'sent') as last_sent_at
  from public.sender_messages m
  where m.recipient_id = r.id
) out_msg on true
left join lateral (
  select
    count(*)                                                as reply_count,
    max(coalesce(p.received_at, p.created_at))              as last_reply_at,
    bool_or(p.kind = 'human')                               as has_human_reply
  from public.sender_replies p
  where p.recipient_id = r.id
) inc on true
where out_msg.sent_count > 0;
