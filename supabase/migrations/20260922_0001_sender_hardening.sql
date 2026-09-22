-- Этап A по хендоффу масштабирования сендера: корректность очереди.
--
-- 1. Статус 'unknown' у письма: провайдер мог принять письмо (обрыв после
--    DATA, сбой записи после отправки) — автоматический ретрай отправил бы
--    получателю дубль, поэтому такие письма терминальны и видны оператору.
-- 2. Claim больше не отдаёт письма сломанных/выключенных ящиков: раньше
--    двадцать писем на мёртвом ящике становились головой очереди навсегда
--    (order by scheduled_at без сдвига) и останавливали отправку в ноль.
-- 3. Индексы под самый горячий запрос системы (вторая ветка claim) и под
--    поиск письма по Message-ID при каждом входящем ответе.

-- ── Статус unknown ───────────────────────────────────────────────────────────
alter table public.sender_messages
  drop constraint sender_messages_status_check;
alter table public.sender_messages
  add constraint sender_messages_status_check
  check (status in ('scheduled', 'sending', 'sent', 'failed', 'canceled', 'unknown'));

-- ── Claim без сломанных ящиков ───────────────────────────────────────────────
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
    select m.id
      from public.sender_messages m
      join public.sender_mailboxes mb on mb.id = m.mailbox_id
     where ((m.status = 'scheduled' and m.scheduled_at <= now())
            or (m.status = 'sending' and m.claimed_at < now() - make_interval(secs => p_stale_after_seconds)))
       -- Ящик вне работы (failed/pending/disabled или снятая галочка) свои
       -- письма не отдаёт: они подождут починки ящика, а не отравляют голову
       -- очереди на каждом проходе.
       and mb.status = 'verified'
       and mb.enabled
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

comment on function public.claim_sender_messages is
  'Atomically claims due sender_messages rows (FOR UPDATE SKIP LOCKED) so concurrent sender workers never send the same email twice; also reclaims rows stuck in sending past p_stale_after_seconds. Rows of mailboxes that are not verified+enabled are skipped until the mailbox is fixed.';

-- ── Индексы ──────────────────────────────────────────────────────────────────
-- Вторая ветка claim (старые 'sending') без индекса сканировала таблицу целиком.
create index if not exists idx_sender_messages_sending_claim
  on public.sender_messages (claimed_at)
  where status = 'sending';
-- Поиск письма при каждом входящем ответе шёл по message_id без индекса.
create index if not exists idx_sender_messages_message_id
  on public.sender_messages (message_id);
