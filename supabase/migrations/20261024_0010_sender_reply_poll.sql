-- «Рассылка»: входящие опрашиваются у работающих ящиков, остальные — раз в сутки.
--
-- 23.10.2026: из 901 подтверждённого ящика на «Рассылку» работали 59, а IMAP
-- обходил все — полный круг шёл 14–32 минуты и держал отправку (опрос шёл в
-- том же цикле). У неработающих за 14 дней пришли только прогрев (93 тыс.),
-- отбои (5 тыс.) и 31 «живой» ответ — всё чужое (ящики общие с Instantly), ни
-- одного привязанного к нашим кампаниям.
--
-- Работающий ящик: в пуле черновика, идущей или остановленной кампании; слал
-- письма кампаний или ручные (ответы оператора, передачи клиенту) за 30 дней;
-- за ним закреплены лиды в работе или ответившие за 60 дней (их переписку и
-- передачу клиенту ведут с этого ящика); входящие у него ещё ни разу не читали
-- (не «ни разу не прочитались»: ящик с нерабочим IMAP иначе считался бы
-- работающим вечно и получал бы неудачный вход каждые 5 минут). Такой ящик опрашивается не чаще p_min_gap_seconds: частые входы
-- провайдеры (Яндекс) принимают за подбор пароля. Остальные — раз в
-- p_idle_gap_seconds: курсор не отстаёт, поздний отбой или ответ не на тот ящик
-- задерживается, а не теряется. Работающие — первыми.
--
-- Воркер без этой миграции (почтовые хосты выкатываются раньше портала) опрашивает
-- по-старому (lib/sender/repliesWorker).

create or replace function public.sender_reply_poll_mailboxes(
  p_egress_ip text,
  p_limit integer,
  p_min_gap_seconds integer default 300,
  p_idle_gap_seconds integer default 86400
)
returns setof public.sender_mailboxes
language sql
stable
as $$
  select m.*
    from public.sender_mailboxes m
    cross join lateral (
      select (
        m.imap_checked_at is null
        or m.last_send_at > now() - interval '30 days'
        or exists (
          select 1 from public.sender_manual_messages mm
           where mm.mailbox_id = m.id
             and (mm.status in ('queued', 'sending')
                  or (mm.status = 'sent' and mm.sent_at > now() - interval '30 days'))
        )
        or exists (
          select 1
            from public.sender_campaign_mailboxes cm
            join public.sender_campaigns c on c.id = cm.campaign_id
           where cm.mailbox_id = m.id
             and c.status in ('draft', 'running', 'paused')
        )
        or exists (
          select 1 from public.sender_recipients r
           where r.mailbox_id = m.id and r.status = 'active'
        )
        or exists (
          select 1 from public.sender_recipients r
           where r.mailbox_id = m.id and r.status = 'replied'
             and r.replied_at > now() - interval '60 days'
        )
      ) as working
    ) w
   where m.status = 'verified'
     and m.enabled
     and m.egress_ip = p_egress_ip
     and m.imap_host is not null
     and (
       m.imap_checked_at is null
       or m.imap_checked_at < now() - make_interval(secs => case when w.working then p_min_gap_seconds else p_idle_gap_seconds end)
     )
   order by w.working desc, m.imap_checked_at asc nulls first
   limit p_limit;
$$;

revoke all on function public.sender_reply_poll_mailboxes(text, integer, integer, integer) from public;
grant execute on function public.sender_reply_poll_mailboxes(text, integer, integer, integer) to service_role;

comment on function public.sender_reply_poll_mailboxes(text, integer, integer, integer) is
  'Mailboxes of one sending address due for an IMAP poll: working ones (campaign pool, recent campaign or manual sends, pinned leads, never attempted) at most every p_min_gap_seconds, the rest every p_idle_gap_seconds; working first.';

-- Поиск ящиков с закреплёнными ответившими лидами и ящиков в пулах кампаний.
create index if not exists idx_sender_recipients_replied_mailbox
  on public.sender_recipients (mailbox_id)
  where status = 'replied';

create index if not exists idx_sender_campaign_mailboxes_mailbox
  on public.sender_campaign_mailboxes (mailbox_id);
