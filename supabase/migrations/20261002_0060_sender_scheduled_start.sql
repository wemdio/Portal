-- Отложенный запуск кампании «Рассылки» (02.10.2026): оператор выбирает время
-- по часовому поясу кампании, воркер-ведущий запускает её, когда оно наступит
-- (lib/sender/scheduledStart.ts). Пока время не пришло, кампания остаётся
-- черновиком или на паузе. Не запустилась — время снимается, причина пишется
-- в scheduled_start_error и видна в списке кампаний.
alter table public.sender_campaigns
  add column if not exists scheduled_start_at timestamptz,
  add column if not exists scheduled_start_error text;

create index if not exists sender_campaigns_scheduled_start_idx
  on public.sender_campaigns (scheduled_start_at)
  where scheduled_start_at is not null;
