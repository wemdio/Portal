-- Telegram freeze_until_date: срок удаления замороженного аккаунта, если
-- апелляция не будет принята. Это не дата автоматического снятия заморозки.
alter table public.tg_outreach_accounts
  add column if not exists freeze_until_at timestamptz;

comment on column public.tg_outreach_accounts.freeze_until_at is
  'Дата удаления замороженного аккаунта без успешной апелляции, полученная из Telegram freeze_until_date. NULL, если Telegram не сообщил срок или аккаунт не заморожен.';
