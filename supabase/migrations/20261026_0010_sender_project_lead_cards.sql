-- «Рассылка»: лиды кампаний Движка вертикалей — как лиды Instantly (этап 5,
-- решение владельца 24.10.2026). Ответ оценивается по брифу проекта, специалисту
-- проекта приходит карточка в Telegram с «Передать клиенту» и «Не лид», лид
-- попадает на доску лидов проекта, передача — письмом «Рассылки» с клиентом в
-- копии.
--
-- Карточка — одна на переписку (получателя). Её ведёт воркер worker-sender-leads
-- (projectLeadCards), кнопки обрабатывает вебхук бота лид-алертов.
--
-- Выключатель: sender_project_lead_settings.enabled. Новые карточки — только
-- для оценок не раньше enabled_at; включение после выключения сдвигает
-- enabled_at, чтобы лиды, оценённые «в выключенное», не пришли пачкой.
-- Сама по себе миграция ничего не меняет: кампаний 've2' в работе ещё нет.

-- ─── Выключатель и отсечка ────────────────────────────────────────────────
create table if not exists public.sender_project_lead_settings (
  id          boolean primary key default true check (id),
  enabled     boolean not null default true,
  enabled_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into public.sender_project_lead_settings (id) values (true)
  on conflict (id) do nothing;

create or replace function public.sender_project_lead_settings_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.enabled and not old.enabled then
    new.enabled_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists sender_project_lead_settings_touch on public.sender_project_lead_settings;
create trigger sender_project_lead_settings_touch
  before update on public.sender_project_lead_settings
  for each row execute function public.sender_project_lead_settings_touch();

revoke all on function public.sender_project_lead_settings_touch() from public, anon, authenticated;

alter table public.sender_project_lead_settings enable row level security;
revoke all on public.sender_project_lead_settings from public, anon, authenticated;
grant all on public.sender_project_lead_settings to service_role;

comment on table public.sender_project_lead_settings is
  'Kill switch for project lead cards of ve2 sender campaigns; cards only for qualifications at or after enabled_at.';

-- ─── Карточки ─────────────────────────────────────────────────────────────
-- pending       — ещё не доставлена (повтор по лесенке, до 7 суток);
-- card_sent     — карточка у специалиста, решение не принято;
-- queued        — письмо передачи в очереди «Рассылки»;
-- sent          — письмо передачи ушло, лид на доске клиента;
-- rejected      — «Не лид»;
-- handoff_failed — письмо передачи не ушло (передать можно заново);
-- undelivered   — карточку так и не доставили (причина в last_error).
create table if not exists public.sender_project_lead_cards (
  recipient_id           uuid primary key references public.sender_recipients(id) on delete cascade,
  reply_id               uuid not null references public.sender_reply_qualifications(reply_id) on delete cascade,
  campaign_id            uuid not null references public.sender_campaigns(id) on delete cascade,
  project_id             uuid not null references public.projects(id) on delete cascade,
  responsible_user_id    uuid,
  handoff_mode           text check (handoff_mode in ('manual', 'auto', 'none')),
  status                 text not null default 'pending'
    check (status in ('pending', 'card_sent', 'queued', 'sent', 'rejected', 'handoff_failed', 'undelivered')),
  draft_text             text,
  blocked_reason         text,
  manual_message_id      uuid references public.sender_manual_messages(id) on delete set null,
  tg_chat_id             text,
  tg_message_id          bigint,
  -- Текст карточки и её кнопки при отправке: правка статусом дописывает строку
  -- к нему; tg_rendered_status — статус, который карточка уже показывает.
  tg_html                text,
  tg_keyboard            jsonb,
  tg_rendered_status     text,
  attempts               integer not null default 0,
  next_attempt_at        timestamptz,
  last_error             text,
  merged_reply_ids       uuid[] not null default '{}',
  board_written_at       timestamptz,
  board_published_at     timestamptz,
  decided_by_user_id     uuid,
  decided_by_telegram_id bigint,
  decided_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists sender_project_lead_cards_pending_idx
  on public.sender_project_lead_cards (next_attempt_at)
  where status = 'pending';
create index if not exists sender_project_lead_cards_open_idx
  on public.sender_project_lead_cards (updated_at)
  where status <> 'pending';

alter table public.sender_project_lead_cards enable row level security;
revoke all on public.sender_project_lead_cards from public, anon, authenticated;
grant all on public.sender_project_lead_cards to service_role;

comment on table public.sender_project_lead_cards is
  'One Telegram lead card per thread of a ve2 sender campaign: specialist decision («Передать клиенту» / «Не лид»), board row and handoff state.';

-- ─── Новые лиды для карточек ───────────────────────────────────────────────
-- Лид кампании 've2' с проектом, оценённый не раньше отсечки. Переписку снимает
-- только ручное «Не лид»: более поздний ответ, оценённый ИИ как «не лид»
-- («спасибо, получили»), настоящего лида не отменяет — как в чате продаж.
-- Без карточки — новая карточка; с доставленной — ещё один ответ лида в ту же
-- строку доски; с недоставленной (undelivered) — повод открыть её заново.
create or replace function public.sender_project_lead_candidates(p_limit integer)
returns table (reply_id uuid, recipient_id uuid, campaign_id uuid, project_id uuid, has_card boolean, card_status text)
language sql
stable
set search_path = ''
as $$
  select q.reply_id, q.recipient_id, q.campaign_id, c.project_id,
         card.recipient_id is not null as has_card, card.status
    from public.sender_reply_qualifications q
    join public.sender_recipients r on r.id = q.recipient_id
    join public.sender_campaigns c on c.id = q.campaign_id
    cross join public.sender_project_lead_settings s
    left join public.sender_project_lead_cards card on card.recipient_id = q.recipient_id
   where s.enabled
     and q.status = 'lead'
     and q.qualified_at >= s.enabled_at
     and c.source_kind = 've2'
     and c.project_id is not null
     and not (coalesce(r.lead_verdict, '') = 'not_lead' and coalesce(r.lead_verdict_source, '') = 'manual')
     and (
       card.recipient_id is null
       or (not (q.reply_id = any(card.merged_reply_ids))
           and ((card.board_written_at is not null and card.status in ('card_sent', 'queued', 'sent'))
                or card.status = 'undelivered'))
     )
   order by q.qualified_at, q.reply_id
   limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

revoke all on function public.sender_project_lead_candidates(integer) from public, anon, authenticated;
grant execute on function public.sender_project_lead_candidates(integer) to service_role;

-- ─── Карточки, которым нужен следующий шаг ─────────────────────────────────
-- По событиям, а не обходом всех открытых (kind — что сделать):
--   sent       — письмо передачи ушло: открыть строку доски, закрыть карточку;
--   publish    — ушло, а карточка ещё не доставлена: только открыть строку;
--   failed     — письмо передачи этой карточки не ушло (в том числе поставленное
--                из «Писем», пока автопередача ждала: второе письмо без человека
--                не отправляем);
--   not_lead   — в «Рассылке» поставили «Не лид»;
--   auto_retry — автопередача была отложена (ящик, стоп-листы): попробовать снова,
--                срок в 7 суток проверяет воркер;
--   stuck      — «в очереди», а письма нет (нажатие оборвалось): вернуть кнопки;
--   render     — текст карточки в Telegram отстал от статуса (для «Не лид» —
--                ещё и повод дописать оборванное нажатие).
create or replace function public.sender_project_lead_card_events(p_limit integer)
returns table (
  recipient_id uuid,
  kind text,
  status text,
  handoff_id uuid,
  handoff_status text,
  handoff_error text,
  handoff_cc text[],
  lead_verdict text,
  lead_verdict_source text
)
language sql
stable
set search_path = ''
as $$
  with h as (
    select distinct on (m.recipient_id)
           m.recipient_id, m.id, m.status, m.error, m.cc_emails, m.created_at
      from public.sender_manual_messages m
      join public.sender_project_lead_cards card on card.recipient_id = m.recipient_id
     where m.handoff is not null
     order by m.recipient_id, m.created_at desc, m.id desc
  ),
  e as (
    select card.recipient_id, card.status, card.updated_at, h.id as handoff_id, h.status as handoff_status,
           h.error as handoff_error, h.cc_emails as handoff_cc, r.lead_verdict, r.lead_verdict_source,
           case
             when h.status = 'sent' and card.status not in ('sent', 'pending') then 'sent'
             when h.status = 'sent' and card.status = 'pending'
                  and card.board_written_at is not null and card.board_published_at is null then 'publish'
             when h.status = 'failed'
                  and ((card.status = 'queued'
                        and (h.id = card.manual_message_id or h.created_at >= coalesce(card.decided_at, card.created_at)))
                       or (card.status = 'card_sent' and card.handoff_mode = 'auto' and h.created_at >= card.created_at)) then 'failed'
             when card.status in ('card_sent', 'handoff_failed', 'undelivered')
                  and r.lead_verdict = 'not_lead' and r.lead_verdict_source = 'manual'
                  and (h.status is null or h.status = 'failed') then 'not_lead'
             when card.status = 'card_sent' and card.handoff_mode = 'auto'
                  and card.blocked_reason is not null and card.manual_message_id is null
                  and (h.status is null or (h.status = 'failed' and h.created_at < card.created_at))
                  and coalesce(card.next_attempt_at, '-infinity'::timestamptz) <= now() then 'auto_retry'
             when card.status = 'queued' and card.manual_message_id is null
                  and card.updated_at < now() - interval '10 minutes'
                  and not exists (
                    select 1 from public.sender_manual_messages m
                     where m.recipient_id = card.recipient_id and m.handoff is not null
                       and m.created_at >= coalesce(card.decided_at, card.created_at)
                  ) then 'stuck'
             when card.status <> 'pending' and card.tg_message_id is not null
                  and card.tg_rendered_status is distinct from card.status
                  -- Нажатие кнопки могло ещё не закончить (занять → отказаться):
                  -- запасная перерисовка ждёт, свежие переходы рисуют сами.
                  and card.updated_at < now() - interval '2 minutes' then 'render'
           end as kind
      from public.sender_project_lead_cards card
      join public.sender_recipients r on r.id = card.recipient_id
      left join h on h.recipient_id = card.recipient_id
  )
  select e.recipient_id, e.kind, e.status, e.handoff_id, e.handoff_status, e.handoff_error, e.handoff_cc,
         e.lead_verdict, e.lead_verdict_source
    from e
   where e.kind is not null
   order by e.updated_at, e.recipient_id
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke all on function public.sender_project_lead_card_events(integer) from public, anon, authenticated;
grant execute on function public.sender_project_lead_card_events(integer) to service_role;
