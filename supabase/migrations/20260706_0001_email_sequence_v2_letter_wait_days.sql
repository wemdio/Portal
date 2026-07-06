-- Цепочки писем 2.0: задержка отправки письма в днях ОТНОСИТЕЛЬНО ПРЕДЫДУЩЕГО
-- (gap, не кумулятив). 0 = «сразу» (первое письмо), по умолчанию 2 дня.
-- UI показывает кумулятивную сумму («через 4 дня»), в мастер «Запуск»
-- значение уходит как wait_days шага (та же семантика, что в клиентском
-- лаунче: пауза перед ЭТИМ письмом).

alter table public.email_sequence_v2_letters
  add column if not exists wait_days integer not null default 2
  check (wait_days between 0 and 90);

-- Бэкфилл: первые письма существующих цепочек отправляются сразу.
update public.email_sequence_v2_letters
  set wait_days = 0
  where letter_index = 1 and wait_days <> 0;
