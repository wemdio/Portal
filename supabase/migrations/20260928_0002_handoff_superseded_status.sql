-- Проверка передачи проектов: статус `superseded` — по той же сделке в ветку
-- пришло более новое сообщение о передаче, старое больше не проверяется и не
-- напоминает (случай 28.09.2026: сообщение переотправили с исправленным
-- «Откуда лид», а предупреждение и будущее напоминание остались на старом).
alter table public.handoff_card_checks
  drop constraint if exists handoff_card_checks_status_check;
alter table public.handoff_card_checks
  add constraint handoff_card_checks_status_check
  check (status in ('ok', 'problems', 'no_link', 'resolved', 'expired', 'superseded'));
