-- Очередь баз кампании LinkedIn: кампания рассылает базы по порядку —
-- закончилась одна, воркер берёт следующую (li_lead_lists.queue_position).
alter table public.li_lead_lists
  add column if not exists queue_position integer;

-- Существующим базам кампании раздаём номера: рассылаемая — первой, остальные по дате создания.
update public.li_lead_lists l
   set queue_position = r.pos
  from (
    select b.id,
           row_number() over (
             partition by b.campaign_id
             order by coalesce(b.id = c.lead_list_id, false) desc, b.created_at, b.id
           ) as pos
      from public.li_lead_lists b
      join public.li_campaigns c on c.id = b.campaign_id
  ) r
 where l.id = r.id and l.queue_position is null;

-- Когда у базы появляется кампания, она встаёт в конец очереди этой кампании.
create or replace function public.li_lead_lists_set_queue_position()
returns trigger
language plpgsql
as $$
begin
  if new.campaign_id is null then
    new.queue_position := null;
  elsif tg_op = 'INSERT' or new.campaign_id is distinct from old.campaign_id then
    select coalesce(max(queue_position), 0) + 1
      into new.queue_position
      from public.li_lead_lists
     where campaign_id = new.campaign_id;
  end if;
  return new;
end;
$$;

drop trigger if exists li_lead_lists_queue_position on public.li_lead_lists;
create trigger li_lead_lists_queue_position
  before insert or update of campaign_id on public.li_lead_lists
  for each row execute function public.li_lead_lists_set_queue_position();

comment on column public.li_lead_lists.queue_position is
  'Order of the base in its campaign queue (1 = first). The worker moves li_campaigns.lead_list_id to the next base when the current one is finished.';
