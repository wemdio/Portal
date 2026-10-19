-- Параметры задачи воркера: удаление сообщений бота в Telegram берёт из них
-- диалог и сообщение. У остальных действий поле пустое.
alter table public.tg_outreach_jobs add column if not exists payload jsonb;
