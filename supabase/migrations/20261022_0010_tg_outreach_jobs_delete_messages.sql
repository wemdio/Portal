-- Команда удаления уже используется API и воркером, но отсутствовала
-- в ограничении очереди. Остальные команды сохраняются без изменений.
alter table public.tg_outreach_jobs
  drop constraint if exists tg_outreach_jobs_action_check,
  add constraint tg_outreach_jobs_action_check
    check (action in (
      'start', 'stop', 'restart', 'refetch_messages',
      'warmup_start', 'warmup_stop', 'delete_messages'
    ));
