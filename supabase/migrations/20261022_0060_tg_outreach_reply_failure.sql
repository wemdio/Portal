-- Диагностика неотправленного ответа отдельно от реальной переписки.
-- Права доступа наследуются от существующей RLS tg_outreach_dialogs.
alter table public.tg_outreach_dialogs
  add column if not exists reply_failure jsonb;

comment on column public.tg_outreach_dialogs.reply_failure is
  'Последний неотправленный черновик: text/reason/timestamp/incomingKey/attempts/retrying/delivery. Не входит в messages и контекст модели.';
