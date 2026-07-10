-- Persist the outcome of the specialist lead-alert Telegram send.
--
-- Before this, a failed sendMessage produced only a transient stdout warn
-- (lost on worker restart), so a silently-undelivered lead alert left NO record.
-- Incident 2026-07-08: 3 PP Prod leads were qualified, notifications + this log's
-- 'specialist' row were written, but the Telegram alert never reached the
-- specialist (Илиана) — and there was no way to prove why after the fact.
--
-- Now the worker updates these columns right after the send, so failures are
-- visible (tg_sent=false + tg_error) and a retry job can pick them up.
alter table public.deadline_notification_log
  add column if not exists tg_sent boolean,
  add column if not exists tg_message_id bigint,
  add column if not exists tg_error text,
  add column if not exists tg_sent_at timestamptz;

-- Fast scan of undelivered specialist alerts (diagnostics / retry).
create index if not exists idx_deadline_log_tg_failed
  on public.deadline_notification_log (entity_type, created_at desc)
  where tg_sent is false;
