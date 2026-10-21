-- Ограниченное окно повторной квалификации ответов «Рассылки».
-- NULL deadline у старых ошибок: воркер назначит им полные 48 часов при
-- первом захвате после выкладки, не списывая давний ответ без новой попытки.
alter table public.sender_reply_qualifications
  add column if not exists retry_deadline_at timestamptz,
  add column if not exists retry_exhausted_at timestamptz;

comment on column public.sender_reply_qualifications.retry_deadline_at is
  'Конец 48-часового окна квалификации. У новых ответов — от постановки в очередь; у старых ошибок — от первого восстановления. Не продлевается при повторе или рестарте.';
comment on column public.sender_reply_qualifications.retry_exhausted_at is
  'Повторы окончательно остановлены по истечении 48 часов. status=error, причина в last_error; больше не брать в автоматическую обработку.';

create index if not exists idx_sender_qualifications_retry_deadline
  on public.sender_reply_qualifications (retry_deadline_at)
  where status in ('pending', 'error') and retry_exhausted_at is null;
