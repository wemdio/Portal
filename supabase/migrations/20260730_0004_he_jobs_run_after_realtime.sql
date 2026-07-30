-- Hypothesis Engine: he_jobs.run_after (отложенный клейм) + realtime-публикация.
--
-- 1. run_after — джоба доступна воркеру не раньше этого момента. Стадия
--    base_collect ждёт дочерние парсеры через self-requeue; без run_after
--    воркер переклеймивал свою строку с нулевой задержкой (hot spin:
--    ~10 запросов к БД на цикл, 30-60+ минут ожидания) и сжигал attempts.
--    Теперь requeue откладывает джобу на 30 секунд, а claimJob берёт только
--    pending с run_after <= now() (app/worker/hypothesisEngine.ts).
-- 2. Частичный индекс (status, run_after) where status='pending' — выборка
--    следующей доступной джобы.
-- 3. he_jobs → публикация supabase_realtime: realtime-wake воркера
--    (pollLoop, app/worker/_shared.ts) без публикации был инертным и всегда
--    работал по 30-секундному fallback-таймеру.
--
-- Grant'ы не нужны — колонка наследует права таблицы.

-- ─── 1. he_jobs.run_after ────────────────────────────────────────────────

alter table public.he_jobs
  add column if not exists run_after timestamptz not null default now();

comment on column public.he_jobs.run_after is
  'Джоба доступна для клейма не раньше этого момента (self-requeue base_collect откладывает на 30с).';

create index if not exists idx_he_jobs_pending_run_after
  on public.he_jobs(status, run_after) where status = 'pending';

-- ─── 2. Realtime publication (wake воркера по INSERT/UPDATE pending) ──────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'he_jobs'
     ) then
    alter publication supabase_realtime add table public.he_jobs;
  end if;
end
$$;
