-- Атомарный claim очереди BYO-отправки (client_byo_messages).
--
-- До этой миграции byoSend.processByoSendBatch делал plain
-- `select ... where status='pending' ... limit N`, а затем отдельным update
-- переводил в 'sent'/'failed' по каждой строке. При нескольких воркерах (или
-- репликах одного воркера) это race: два прохода могли выбрать одну и ту же
-- pending-строку и отправить письмо дважды. P0 из handoff 2026-09-14
-- (sender MVP вместо Instantly) — воркеры переезжают на отдельный сервер,
-- где такой сценарий реален уже не гипотетически.
--
-- Транзиентный статус 'sending' помечает письмо как забранное конкретным
-- проходом. claim_byo_messages использует FOR UPDATE SKIP LOCKED — конкурентный
-- проход просто пропускает уже забранные строки, а не ждёт лока и не дублирует.
-- Дополнительно функция переиспользует «зависшие» sending-строки старше
-- p_stale_after_seconds: если воркер упал между claim и финальным update,
-- письмо не потеряно навсегда, а возвращается в оборот со следующего claim.

alter table public.client_byo_messages
  add column if not exists claimed_at timestamptz;

alter table public.client_byo_messages
  drop constraint if exists client_byo_messages_status_check;

alter table public.client_byo_messages
  add constraint client_byo_messages_status_check
  check (status in ('pending', 'sending', 'sent', 'failed', 'skipped', 'canceled'));

create or replace function public.claim_byo_messages(
  p_limit integer,
  p_stale_after_seconds integer default 600
)
returns setof public.client_byo_messages
language plpgsql
as $$
begin
  return query
  with picked as (
    select id
      from public.client_byo_messages
     where (status = 'pending' and scheduled_at <= now())
        or (status = 'sending' and claimed_at < now() - make_interval(secs => p_stale_after_seconds))
     order by scheduled_at
     limit p_limit
     for update skip locked
  )
  update public.client_byo_messages m
     set status = 'sending',
         claimed_at = now()
    from picked
   where m.id = picked.id
  returning m.*;
end;
$$;

comment on function public.claim_byo_messages is
  'Atomically claims up to p_limit due client_byo_messages rows (FOR UPDATE SKIP LOCKED), marking them sending so concurrent byoSend worker instances never pick the same row twice. Also reclaims rows stuck in sending past p_stale_after_seconds (worker crashed mid-send) so a claimed-but-unresolved message is retried instead of lost forever.';
