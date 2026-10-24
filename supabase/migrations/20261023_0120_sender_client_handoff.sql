-- «Рассылка»: передача лида клиенту с копией (lib/sender/clientHandoff).
--
-- Письмо передачи — ручное письмо с копией клиенту. В handoff лежит, что
-- записать клиенту в кабинет («Лиды», client_forwarded_leads в базе Instantly):
-- запись делает воркер sender-leads только после того, как письмо ушло, и
-- отмечает handoff_recorded_at. Почтовые хосты базы Instantly не видят, поэтому
-- не они.
alter table public.sender_manual_messages
  add column if not exists handoff jsonb,
  add column if not exists handoff_recorded_at timestamptz;

comment on column public.sender_manual_messages.handoff is
  'Lead handoff to the client: the client_forwarded_leads row to record once this letter is sent; null for ordinary replies.';
comment on column public.sender_manual_messages.handoff_recorded_at is
  'When the handoff was recorded in the client cabinet (or found to need no record).';

-- Один лид — одна передача: повторный клик или второй оператор не шлют лиду
-- второе письмо с клиентом в копии. Неудавшуюся передачу можно повторить.
create unique index if not exists sender_manual_messages_one_handoff
  on public.sender_manual_messages (recipient_id)
  where handoff is not null and status <> 'failed';

-- Записать в кабинет: ушедшие передачи, ещё не записанные.
create index if not exists sender_manual_messages_handoff_pending
  on public.sender_manual_messages (sent_at)
  where handoff is not null and status = 'sent' and handoff_recorded_at is null;

-- Кому ещё лид написал в ответе: при передаче они остаются в копии, как
-- «ответить всем» у Instantly.
alter table public.sender_replies
  add column if not exists to_emails text[] not null default '{}',
  add column if not exists cc_emails text[] not null default '{}';

comment on column public.sender_replies.to_emails is 'To addresses of the incoming letter (IMAP envelope).';
comment on column public.sender_replies.cc_emails is 'Cc addresses of the incoming letter (IMAP envelope).';

-- Письмо передачи, как и автопредставление агентства, не забирается повторно
-- из «sending»: исход прерванной отправки неизвестен, а повтор прислал бы лиду
-- и клиенту второе письмо. Зависшее письмо воркер sender-leads переводит в
-- «не ушло» с объяснением (lib/sender/clientHandoff). Ответы оператора —
-- как раньше.
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
      (mm.status = 'sending' and mm.agency_handoff_id is null and mm.handoff is null
        and mm.updated_at < now() - make_interval(secs => p_stale_after_seconds)))
      and mb.egress_ip = p_egress_ip
    order by mm.created_at limit p_limit for update of mm skip locked
  )
  update public.sender_manual_messages m
    set status = 'sending', updated_at = now()
    from picked where m.id = picked.id returning m.*;
end;
$$;
