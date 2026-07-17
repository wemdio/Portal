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
--
-- Non-blocking форма (была одна миграция с ADD COLUMN NOT NULL DEFAULT now(),
-- которая делает full table rewrite и вешает ACCESS EXCLUSIVE lock надолго —
-- при активном воркере не успевает за DB_MIGRATION_LOCK_TIMEOUT=30s и валит
-- деплой с 55P03). Разбито на короткие шаги, каждый — миллисекунды.

-- 1. Колонка без DEFAULT — только metadata, без rewrite, мгновенно.
alter table public.yandex_maps_jobs
  add column if not exists updated_at timestamptz;

-- 2. Backfill старых строк. UPDATE блокирует только затрагиваемые строки,
--    не всю таблицу; для таблицы очередей это обычно сотни-тысячи строк.
update public.yandex_maps_jobs
  set updated_at = coalesce(created_at, now())
  where updated_at is null;

-- 3. DEFAULT для будущих INSERT'ов — тоже только metadata, мгновенно.
alter table public.yandex_maps_jobs
  alter column updated_at set default now();

-- Оставляем nullable — watchdog всё равно смотрит только status='running',
-- зомби-задачи создаются уже с default'ом. NOT NULL требует scan и здесь
-- не даёт ничего полезного, только ещё один короткий ACCESS EXCLUSIVE lock.

-- 4. Общий trigger-хелпер: обновить updated_at до now() при любом UPDATE.
--    Если уже существует от другой миграции — не пересоздаём.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 5. Триггер. Короткий exclusive lock, миллисекунды.
drop trigger if exists trg_yandex_maps_jobs_updated_at on public.yandex_maps_jobs;
create trigger trg_yandex_maps_jobs_updated_at
  before update on public.yandex_maps_jobs
  for each row execute function public.set_updated_at();

-- 6. Индекс для быстрого поиска "зомби": watchdog делает
--    WHERE status='running' AND updated_at < now() - interval '15 minutes'.
--    CONCURRENTLY нельзя (мы внутри транзакции миграции); обычный CREATE INDEX
--    блокирует только writes, а для активной таблицы очередей строк немного.
create index if not exists idx_yandex_maps_jobs_running_updated_at
  on public.yandex_maps_jobs(status, updated_at)
  where status = 'running';
