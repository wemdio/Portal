-- «Рассылка»: письмо не уходит получателю, который уже ответил, отписался или
-- отбился, и не уходит из кампании на паузе или завершённой.
--
-- Планировщик ставит письмо в очередь заранее — на минуту внутри окна
-- отправки, это часы вперёд. claim_sender_messages (20260924_0020) брал из
-- очереди всё, чему пришло время, не глядя ни на получателя, ни на кампанию:
-- ответ, пришедший между планированием и отправкой, не останавливал уже
-- поставленное письмо, и follow-up уходил человеку, который только что
-- ответил. Пауза снимает очередь (status → canceled), но письмо, поставленное
-- планировщиком в ту же секунду, всё равно уходило.
--
-- Теперь письмо берётся, только если кампания идёт, а получатель активен.
-- Остальные письма, которым пришло время, снимает тот же вызов:
--   • запланированные — canceled: они никуда не уходили, а продолжение
--     кампании после паузы удаляет отменённые и ставит получателя в очередь
--     заново (campaignOps.startCampaign);
--   • зависшие в sending — unknown: упавший воркер мог успеть отправить,
--     повтор выбывшему получателю хуже, чем разбор оператором.
-- Молча пропускать такие письма нельзя: они вечно висели бы в очереди и
-- съедали дневной лимит ящика — планировщик считает scheduled и sending.
--
-- Остальное — как в 20260924_0020: сигнатура, только свой адрес отправки,
-- проверенный включённый ящик, FOR UPDATE SKIP LOCKED, подбор зависших.

create or replace function public.claim_sender_messages(
  p_limit integer,
  p_egress_ip text,
  p_stale_after_seconds integer default 600
)
returns setof public.sender_messages
language plpgsql
as $$
begin
  -- Снять письма выбывших получателей и остановленных кампаний. Пачкой: при
  -- большом хвосте остаток снимут следующие вызовы, claim их всё равно не берёт.
  with dead as (
    select m.id
      from public.sender_messages m
      join public.sender_mailboxes mb on mb.id = m.mailbox_id
      join public.sender_campaigns c on c.id = m.campaign_id
      join public.sender_recipients r on r.id = m.recipient_id
     where ((m.status = 'scheduled' and m.scheduled_at <= now())
            or (m.status = 'sending' and m.claimed_at < now() - make_interval(secs => p_stale_after_seconds)))
       and mb.egress_ip = p_egress_ip
       and (c.status <> 'running' or r.status <> 'active')
     limit 1000
     for update of m skip locked
  )
  update public.sender_messages m
     set status = case when m.status = 'scheduled' then 'canceled' else 'unknown' end,
         error = case
                   when m.status = 'scheduled'
                     then 'Снято перед отправкой: получатель уже ответил или выбыл, либо кампания не идёт'
                   else 'Отправка прервалась, а получатель уже выбыл или кампания не идёт — проверить вручную'
                 end
    from dead
   where m.id = dead.id;

  return query
  with picked as (
    select m.id
      from public.sender_messages m
      join public.sender_mailboxes mb on mb.id = m.mailbox_id
      join public.sender_campaigns c on c.id = m.campaign_id
      join public.sender_recipients r on r.id = m.recipient_id
     where ((m.status = 'scheduled' and m.scheduled_at <= now())
            or (m.status = 'sending' and m.claimed_at < now() - make_interval(secs => p_stale_after_seconds)))
       and mb.status = 'verified'
       and mb.enabled
       -- Письмо уходит только с адреса своего ящика; чужие письма воркер не
       -- видит, поэтому и «подобрать зависшее» у соседа не может.
       and mb.egress_ip = p_egress_ip
       and c.status = 'running'
       and r.status = 'active'
     order by m.scheduled_at
     limit p_limit
     for update of m skip locked
  )
  update public.sender_messages m
     set status = 'sending',
         claimed_at = now()
    from picked
   where m.id = picked.id
  returning m.*;
end;
$$;

comment on function public.claim_sender_messages(integer, text, integer) is
  'Atomically claims due sender_messages rows of verified+enabled mailboxes pinned to p_egress_ip (FOR UPDATE SKIP LOCKED), only for running campaigns and active recipients; also reclaims rows stuck in sending past p_stale_after_seconds (same egress IP). Due rows of non-running campaigns or inactive recipients are canceled (scheduled) or marked unknown (stuck in sending) instead of being sent.';
