-- «Рассылка»: первые письма кампаний начиная с момента — для факта периода
-- проекта (ночная синхронизация contacts_done, projectContactsSync.ts).
--
-- У кампаний Instantly факт периода — прирост сверх baseline, снятого при
-- привязке кампании к периоду: истории отправок по времени там нет. У своей
-- «Рассылки» время первого письма известно, поэтому период считает письма,
-- ушедшие с его открытия (created_at периода — нажатие «Новый период»). Так
-- кампания, начатая в прошлом периоде, сама переходит в новый, и письма между
-- открытием периода и привязкой не теряются.
--
-- Время первого письма — отдельная запись (sender_first_sends), а не
-- sender_messages: письма удаляются вместе с ящиком (on delete cascade), и
-- факт периода уменьшался бы после удаления ящика. И не поле получателя:
-- отметка «отправлено» тогда держала бы строку получателя, а удаление ящика
-- берёт те же строки в обратном порядке — взаимная блокировка, в которой
-- проигрывает отправка. Пишет запись триггер на отправке письма шага 1 —
-- код на почтовых серверах не меняется. Заполнять прошлое не нужно:
-- считаются только кампании Движка вертикалей, а их до этой миграции нет.

create table if not exists public.sender_first_sends (
  -- Без внешнего ключа на получателя: вставка не должна брать его строку.
  recipient_id  uuid primary key,
  campaign_id   uuid not null references public.sender_campaigns(id) on delete cascade,
  first_sent_at timestamptz not null
);

create index if not exists sender_first_sends_campaign_idx
  on public.sender_first_sends (campaign_id, first_sent_at);

alter table public.sender_first_sends enable row level security;
revoke all on public.sender_first_sends from public, anon, authenticated;
grant all on public.sender_first_sends to service_role;

comment on table public.sender_first_sends is
  'When letter 1 went to each sender recipient (written once by trigger on sender_messages); survives mailbox deletion. Filled from 2026-10-24 on.';

create or replace function public.sender_record_first_send()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.sender_first_sends (recipient_id, campaign_id, first_sent_at)
  values (new.recipient_id, new.campaign_id, coalesce(new.sent_at, now()))
  on conflict (recipient_id) do nothing;
  return null;
end;
$$;

drop trigger if exists sender_messages_first_send on public.sender_messages;
create trigger sender_messages_first_send
  after insert or update of status on public.sender_messages
  for each row when (new.step_no = 1 and new.status = 'sent')
  execute function public.sender_record_first_send();

revoke all on function public.sender_record_first_send() from public, anon, authenticated;

-- Первые письма кампаний: p_since null — за всё время (то же правило, что
-- sender_campaign_first_contacted: last_step_sent >= 1), иначе — получатели,
-- чьё первое письмо ушло не раньше момента. Массивы — пары «кампания, с
-- какого момента»; разной длины — ошибка: иначе недостающий момент стал бы
-- null и посчитал бы всё время.
create or replace function public.sender_campaign_first_contacted_since(
  p_campaign_ids uuid[],
  p_since timestamptz[]
)
returns table (campaign_id uuid, first_contacted bigint)
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_campaign_ids), 0) <> coalesce(cardinality(p_since), 0) then
    raise exception 'campaign ids and since moments must be pairs';
  end if;
  return query
    select c.id,
           case when x.since is null then
             (select count(*) from public.sender_recipients r
               where r.campaign_id = c.id and r.last_step_sent >= 1)
           else
             (select count(*) from public.sender_first_sends f
               where f.campaign_id = c.id and f.first_sent_at >= x.since)
           end
      from unnest(p_campaign_ids, p_since) as x(campaign_id, since)
      join public.sender_campaigns c on c.id = x.campaign_id;
end;
$$;

revoke all on function public.sender_campaign_first_contacted_since(uuid[], timestamptz[]) from public, anon, authenticated;
grant execute on function public.sender_campaign_first_contacted_since(uuid[], timestamptz[]) to service_role;
