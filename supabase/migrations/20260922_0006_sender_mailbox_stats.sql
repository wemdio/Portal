-- Задача 6.3 хендоффа фич: reply rate по ящику и домену.
--
-- Разрез «получатель ↔ ящик» одним запросом через PostgREST не собирается
-- (нужны group by и два разных счётчика), поэтому считаем заранее в представлении.
-- Коррелированные подзапросы дёшевы: ящиков сотни, а не миллионы.

create or replace view public.sender_mailbox_stats as
select
  mb.id          as mailbox_id,
  mb.email,
  substring(mb.email from '@(.*)$') as domain,
  mb.status,
  mb.enabled,
  (select count(*) from public.sender_recipients r
    where r.mailbox_id = mb.id and r.last_step_sent > 0)          as reached,
  (select count(*) from public.sender_recipients r
    where r.mailbox_id = mb.id and r.status = 'replied')           as replied,
  (select count(*) from public.sender_recipients r
    where r.mailbox_id = mb.id and r.status = 'bounced')           as bounced,
  (select count(*) from public.sender_messages m
    where m.mailbox_id = mb.id and m.status = 'sent')              as sent
from public.sender_mailboxes mb;

grant select on public.sender_mailbox_stats to service_role;

comment on view public.sender_mailbox_stats is
  'Lifetime reply/bounce counters per sender mailbox (task 6.3): reached = recipients with at least one letter from this mailbox, replied = human answers among them.';
