-- «Рассылка»: упавшие ящики перепроверяются сами, их лиды не стоят вечно.
--
-- До этого ящик в «Ошибке» не перепроверял никто (проверка брала только
-- «pending»), письма на нём не забирались и не отменялись, а получатели,
-- закреплённые за ним, стояли. 23.10.2026 так стояли 116 лидов на трёх ящиках,
-- один из них упал от временного 421 «Server busy» у Gmail.
--
-- Решение владельца 23.10: ящик перепроверяется с нарастающей паузой; лиды,
-- которым с него ещё не писали, отдаются другому ящику кампании; тем, кому
-- писали, цепочка завершается, если ящик не поднялся за 3 дня
-- (lib/sender/mailboxRecheck, lib/sender/deadMailboxes).

alter table public.sender_mailboxes
  add column if not exists failed_at timestamptz,
  add column if not exists recheck_attempts integer not null default 0,
  add column if not exists next_recheck_at timestamptz;

comment on column public.sender_mailboxes.failed_at is
  'When the mailbox last went to status failed; null while it is not failed.';
comment on column public.sender_mailboxes.recheck_attempts is
  'Automatic login re-checks since the mailbox failed (or transient check failures while pending).';
comment on column public.sender_mailboxes.next_recheck_at is
  'When the worker of the mailbox''s sending address checks the login again; null — no automatic check.';

-- Часы падения ведёт база, а не каждый писатель статуса: ящик в «Ошибку»
-- переводят и проверка, и отправка (два места), и до этой миграции ни одно не
-- записывало время. Смена статуса на любой другой — чистый лист.
create or replace function public.sender_mailboxes_failure_clock()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'failed' then
      new.failed_at := now();
      new.recheck_attempts := 0;
      new.next_recheck_at := now() + interval '15 minutes';
    else
      new.failed_at := null;
      new.recheck_attempts := 0;
      new.next_recheck_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sender_mailboxes_failure_clock on public.sender_mailboxes;
create trigger sender_mailboxes_failure_clock
  before update of status on public.sender_mailboxes
  for each row execute function public.sender_mailboxes_failure_clock();

-- Ящики, упавшие до миграции: когда именно — неизвестно, часы идут с выкладки.
-- Первая перепроверка — сразу.
update public.sender_mailboxes
   set failed_at = now(), recheck_attempts = 0, next_recheck_at = now()
 where status = 'failed' and failed_at is null;

-- Выборка воркера адреса: свои упавшие включённые ящики, чья перепроверка подошла.
create index if not exists sender_mailboxes_recheck_due
  on public.sender_mailboxes (egress_ip, next_recheck_at)
  where status = 'failed' and enabled;

-- Разбор лидов: активные получатели упавших ящиков.
create index if not exists idx_sender_recipients_active_mailbox
  on public.sender_recipients (mailbox_id)
  where status = 'active';

-- Цепочка, завершённая из-за мёртвого ящика, записывается в стоп-лист кампании
-- с этой причиной: видно, почему лиду больше не пишут.
alter table public.sender_campaign_suppressions
  drop constraint if exists sender_campaign_suppressions_reason_check;

alter table public.sender_campaign_suppressions
  add constraint sender_campaign_suppressions_reason_check
  check (reason in ('hard_bounce', 'unsubscribe', 'manual', 'complaint', 'client_blocklist', 'project_block', 'mailbox_lost'));
