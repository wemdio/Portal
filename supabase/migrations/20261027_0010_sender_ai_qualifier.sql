-- Квалифицирующий ИИ автоаутрича RU/EN
-- (docs/superpowers/specs/2026-10-27-auto-outreach-qualifying-ai-design.md).
-- ИИ ведёт переписку с лидом и передаёт менеджерам только подтвердивших
-- актуальность и приславших слоты/телефон/контакт. Одна строка на получателя.

create table if not exists public.sender_ai_conversations (
  recipient_id uuid primary key references public.sender_recipients(id) on delete cascade,
  campaign_id uuid not null references public.sender_campaigns(id) on delete cascade,
  folder_key text not null check (folder_key in ('auto_ru','auto_en')),
  state text not null default 'active'
    check (state in ('active','handed_off','no_reply','closed','stopped','failed')),
  ai_messages integer not null default 0,
  reminder_sent boolean not null default false,
  -- Последнее обработанное письмо лида; до первого хода — null.
  last_reply_id uuid references public.sender_replies(id) on delete set null,
  -- Ответ с интересом, с которого начался разговор.
  trigger_reply_id uuid not null references public.sender_replies(id) on delete cascade,
  last_ai_sent_at timestamptz,
  next_action_at timestamptz,
  handoff_reply_id uuid references public.sender_replies(id) on delete set null,
  handoff_contact text,
  summary text,
  attempts integer not null default 0,
  last_error text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sender_ai_conversations_due_idx
  on public.sender_ai_conversations (state, next_action_at);

alter table public.sender_ai_conversations enable row level security;
revoke all on public.sender_ai_conversations from anon, authenticated;
grant all on public.sender_ai_conversations to service_role;

-- Настройки ИИ у папки: включается отдельно для auto_ru и auto_en,
-- «Короткое КП» — единственный источник цен и кейсов для писем ИИ.
alter table public.sender_folders
  add column if not exists ai_enabled boolean not null default false,
  add column if not exists ai_enabled_at timestamptz,
  add column if not exists ai_offer_text text;

-- Письма ИИ идут той же очередью, что ручные ответы; флаг отличает их от
-- ответов оператора (ответ оператора останавливает ИИ).
alter table public.sender_manual_messages
  add column if not exists by_ai boolean not null default false;

-- Письмо ИИ, зависшее в 'sending', повторно не забираем: оно могло уйти,
-- повтор прислал бы лиду дубль (как у автопередачи и передачи клиенту).
create or replace function public.claim_sender_manual_messages(
  p_limit integer, p_egress_ip text, p_stale_after_seconds integer default 600
)
returns setof public.sender_manual_messages language plpgsql as $$
begin
  return query
  with picked as (
    select mm.id
    from public.sender_manual_messages mm
    join public.sender_mailboxes mb on mb.id = mm.mailbox_id
    where (mm.status = 'queued' or
      (mm.status = 'sending' and mm.agency_handoff_id is null and mm.handoff is null and not mm.by_ai
        and mm.updated_at < now() - make_interval(secs => p_stale_after_seconds)))
      and mb.egress_ip = p_egress_ip
    order by mm.created_at limit p_limit for update of mm skip locked
  )
  update public.sender_manual_messages m
    set status = 'sending', updated_at = now()
    from picked where m.id = picked.id returning m.*;
end;
$$;
