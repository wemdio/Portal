-- Задачи 5.7 + 5.8 хендоффа масштаба: реакция на репутацию и мониторинг.
--
-- sender_alert_state — дедуп алертов: один ключ = один сигнал не чаще раза в
-- период, иначе воркер будет спамить в TG каждые 5 минут, пока проблема жива.
-- sender_domain_health() — счётчики отправлено/отбилось по домену за скользящее
-- окно: по ним считается bounce rate и срабатывает автопауза домена.

create table if not exists public.sender_alert_state (
  key text primary key,
  fired_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

alter table public.sender_alert_state enable row level security;

grant all on public.sender_alert_state to service_role;

comment on table public.sender_alert_state is
  'Alert dedup state for the sender monitor: one key = one signal, refire allowed only after the cooldown window.';

-- Отбоями считаем получателей в статусе bounced (его ставит и SMTP-отказ
-- 5.1.x, и разбор отбойника из входящих) — у самих строк писем кода класса
-- ошибки нет, только текст провайдера.
create or replace function public.sender_domain_health(p_hours integer default 24)
returns table (domain text, sent bigint, bounced bigint)
language sql
stable
as $$
  with mbx as (
    select id, substring(email from '@(.*)$') as domain
      from public.sender_mailboxes
     where enabled
  ),
  sent as (
    select mbx.domain as domain, count(*) as n
      from public.sender_messages m
      join mbx on mbx.id = m.mailbox_id
     where m.status = 'sent'
       and m.sent_at > now() - make_interval(hours => p_hours)
     group by 1
  ),
  bounced as (
    select mbx.domain as domain, count(*) as n
      from public.sender_recipients r
      join mbx on mbx.id = r.mailbox_id
     where r.status = 'bounced'
       and r.updated_at > now() - make_interval(hours => p_hours)
     group by 1
  )
  select mbx.domain,
         coalesce(sent.n, 0)   as sent,
         coalesce(bounced.n, 0) as bounced
    from (select distinct domain from mbx) mbx
    left join sent on sent.domain = mbx.domain
    left join bounced on bounced.domain = mbx.domain
   where coalesce(sent.n, 0) > 0 or coalesce(bounced.n, 0) > 0
$$;

comment on function public.sender_domain_health is
  'Sliding-window send/bounce counters per mailbox domain for reputation autopause (sender monitor, task 5.7). A bounce is a recipient in bounced status, whichever contour (SMTP reject or DSN) set it.';
