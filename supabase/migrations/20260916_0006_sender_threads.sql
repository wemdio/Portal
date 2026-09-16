-- Вкладка «Письма»: переписка по каждому получателю, которому уже ушло письмо.
--
-- Диалог — это получатель кампании (sender_recipients): с ним связаны и наши
-- письма (sender_messages), и его ответы (sender_replies). Список диалогов
-- сортируется по последнему событию — неважно, было это наше письмо или его
-- ответ, — поэтому сортировочное поле нужно считать заранее, а не в приложении:
-- иначе «сверху новые» пришлось бы собирать выборкой всех строк в память.
--
-- Представление, а не таблица: ничего нового не хранится, это тот же набор
-- строк под другим углом. Пересчёт при каждом запросе дешёвый — обе стороны
-- диалога ищутся по индексу на recipient_id.

-- Ответы искались по recipient_id без индекса: у sender_messages такой индекс
-- уже есть (он же unique (recipient_id, step_no)), у ответов не было.
create index if not exists idx_sender_replies_recipient
  on public.sender_replies (recipient_id)
  where recipient_id is not null;

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
  -- Сортировочное поле вкладки: последнее событие переписки в любую сторону.
  greatest(
    coalesce(out_msg.last_sent_at, to_timestamp(0)),
    coalesce(inc.last_reply_at, to_timestamp(0))
  )                                     as last_activity_at
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
-- Пока письмо не ушло, переписки нет: черновики и запланированное на вкладке
-- «Письма» только мешали бы искать тех, с кем разговор уже идёт.
where out_msg.sent_count > 0;

grant select on public.sender_threads to service_role;

comment on view public.sender_threads is
  'Conversations of the sender tool: one row per recipient that already received a message, with counters and the timestamp of the last event in either direction (used for sorting the Письма tab).';
