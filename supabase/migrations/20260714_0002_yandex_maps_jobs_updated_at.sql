-- yandex_maps_jobs.updated_at + trigger автоматического обновления.
--
-- Проблема: воркер зависал на 3+ часа (retry-loop к supabase после сбоя
-- пула соединений PostgREST), задача оставалась в статусе 'running' в БД
-- и занимала слот воркера (MAX_CONCURRENCY=2). Новые задачи стояли в
-- очереди, пока не приходил человек с plink'ом.
--
-- Решение: updated_at обновляется автоматически на каждом UPDATE строки.
-- Отдельный watchdog в воркере раз в 5 мин ищет running-задачи с
-- updated_at старее 15 мин и переводит в failed. Слот освобождается,
-- очередь двигается, юзер видит "автоматически остановлено, попробуйте
-- заново с меньшим числом URL".

alter table public.yandex_maps_jobs
  add column if not exists updated_at timestamptz not null default now();

-- Общий trigger-хелпер: обновить updated_at до now() при любом UPDATE.
-- Если уже существует от другой миграции — не пересоздаём.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_yandex_maps_jobs_updated_at on public.yandex_maps_jobs;
create trigger trg_yandex_maps_jobs_updated_at
  before update on public.yandex_maps_jobs
  for each row execute function public.set_updated_at();

-- Индекс для быстрого поиска "зомби": watchdog делает
--   WHERE status='running' AND updated_at < now() - interval '15 minutes'
create index if not exists idx_yandex_maps_jobs_running_updated_at
  on public.yandex_maps_jobs(status, updated_at)
  where status = 'running';
