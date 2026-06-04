-- Enrich Coordinator pattern: fan-in buffer для результатов scraping'а.
--
-- Контекст. Сейчас N enrich-воркеров параллельно скрейпят сайты и каждый сам
-- пишет результат в БД:
--   • UPDATE website_enrichment_queue SET status='completed', result_text=… WHERE id=$1
--   • UPSERT website_enrichment_cache (domain TTL-cache)
--   • UPDATE website_enrichment_jobs SET processed=…, success_count=… WHERE id=$1
-- С 3 воркерами × 200 URL в полёте = ~600 параллельных запросов в БД,
-- наугад на одни и те же страницы счётчика jobs (lock contention). Добавление
-- ещё реплик упирается в DB-пул (Supabase pooler, ~50-100 conn limit).
--
-- Coordinator pattern меняет это так:
--   • scraper-воркер пишет ОДНУ строку в этот buffer (1 INSERT, ~5ms)
--   • один coordinator-процесс drain'ит buffer пачками по 50-100 строк
--     и атомарно flushит результаты в queue/cache/jobs батч-апсёртом
--     (1 UPDATE на 100 строк вместо 100 UPDATE)
--   • кол-во подключений к БД от scraper'ов фиксировано (Supabase REST
--     каждый воркер всё равно держит ~3-5 conn), но *write-heavy путь*
--     централизован — пул не растёт линейно с числом scraper'ов
--
-- Buffer — это короткоживущая landing-таблица, не persistent state. Строки
-- удаляются coordinator'ом сразу после успешного flush'а. Если coordinator
-- упал — записи переживают рестарт (drain at-least-once с idempotent flush).

create table if not exists public.website_enrichment_results_buffer (
  id          bigint generated always as identity primary key,
  -- Каждая строка ссылается на свой queue-item. Это primary handle для
  -- coordinator'а: какому queue-row проставить result_text/status.
  queue_id    uuid not null references public.website_enrichment_queue(id) on delete cascade,
  -- Денормализованный job_id, чтобы coordinator не делал лишнего JOIN при
  -- инкременте processed/success_count на jobs.
  job_id      uuid not null references public.website_enrichment_jobs(id) on delete cascade,
  -- Тип ответа: успешный текст / ошибка / skipped / cache-only (для
  -- обновления domain-кэша без изменения queue-row).
  status      text not null check (status in ('completed','failed','skipped','cache_only')),
  result_text text,
  last_error  text,
  -- Денормализованные данные для batch-upsert'а в website_enrichment_cache.
  -- Coordinator решает, делать ли upsert в кэш на основании cache_url_normalized.
  cache_url_normalized text,
  cache_source_url     text,
  -- attempt_count нужен для retry-логики в coordinator'е (пишется как есть
  -- из scraper'а, без модификаций).
  attempt_count int not null default 1,
  created_at  timestamptz not null default now(),
  -- Какой воркер записал — helpful для разбора инцидентов («почему один
  -- worker генерит всю нагрузку?»). Имя берётся из process.env.HOSTNAME
  -- (docker compose container name).
  written_by  text
);

-- Главный полный индекс для polling'а coordinator'ом:
-- SELECT ... ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100.
-- По id (= по времени) даёт FIFO drain без timestamp-комиссий.
create index if not exists website_enrichment_results_buffer_id_idx
  on public.website_enrichment_results_buffer (id);

-- Для backlog-стата в UI/healthcheck.
create index if not exists website_enrichment_results_buffer_job_idx
  on public.website_enrichment_results_buffer (job_id);

-- RLS. Buffer — internal infrastructure, доступ только service_role.
alter table public.website_enrichment_results_buffer enable row level security;

-- Для consistency со schema, политика на authenticated не нужна.
-- Worker и coordinator ходят под service_role через supabaseAdmin.

grant all on public.website_enrichment_results_buffer to service_role;

comment on table public.website_enrichment_results_buffer is
  'Fan-in buffer для enrich-coordinator паттерна. Scraper-воркеры пишут по 1 строке на обработанный URL, coordinator drain''ит пачками и flush''ит в queue/cache/jobs. Должна быть пуста или близко к нулю в стабильном состоянии; рост = coordinator отстаёт.';
comment on column public.website_enrichment_results_buffer.status is
  'cache_only = записать только domain-кэш, queue-row не трогать (используется для side-effect кэширования при ретраях).';

-- RPC для атомарного drain'а: SELECT с SKIP LOCKED + DELETE returning, всё в
-- одной транзакции. Один coordinator-процесс берёт batch и сразу удаляет, не
-- оставляя «в работе» строк, которые могут засосать другой воркер.
--
-- Сделано как RPC, а не INSERT/UPDATE/DELETE из JS, чтобы атомарность была
-- железная: между SELECT FOR UPDATE и DELETE никто не успеет вставить новый
-- DELETE'а с теми же id.
create or replace function public.drain_enrich_results_buffer(p_batch_size int default 100)
returns table (
  id          bigint,
  queue_id    uuid,
  job_id      uuid,
  status      text,
  result_text text,
  last_error  text,
  cache_url_normalized text,
  cache_source_url text,
  attempt_count int
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select b.id
      from public.website_enrichment_results_buffer b
     order by b.id
     for update skip locked
     limit p_batch_size
  ),
  removed as (
    delete from public.website_enrichment_results_buffer b
     using picked
     where b.id = picked.id
    returning b.*
  )
  select removed.id,
         removed.queue_id,
         removed.job_id,
         removed.status,
         removed.result_text,
         removed.last_error,
         removed.cache_url_normalized,
         removed.cache_source_url,
         removed.attempt_count
    from removed;
end;
$$;

grant execute on function public.drain_enrich_results_buffer(int) to service_role;

comment on function public.drain_enrich_results_buffer is
  'Атомарно вытаскивает batch из website_enrichment_results_buffer (SKIP LOCKED + DELETE returning). Дает at-least-once semantics при условии что coordinator идемпотентно применяет result_text/status к queue-row.';

-- ─── Atomic counters для website_enrichment_jobs ───────────────────────────
--
-- Coordinator после flush'а batch'а инкрементит processed/success/error на
-- jobs (агрегаты UI и watchdog читают их). Это нужно делать атомарно per-job,
-- иначе при параллельных batch'ах от двух coordinator'ов (или race с legacy
-- websiteEnrichmentWorker.flushProgress) read-modify-write теряет инкременты.

create or replace function public.increment_website_enrichment_job_counters(
  p_job_id        uuid,
  p_processed_inc int default 0,
  p_success_inc   int default 0,
  p_error_inc     int default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.website_enrichment_jobs
     set processed     = coalesce(processed, 0) + greatest(0, p_processed_inc),
         success_count = coalesce(success_count, 0) + greatest(0, p_success_inc),
         error_count   = coalesce(error_count, 0) + greatest(0, p_error_inc)
   where id = p_job_id;
end;
$$;

grant execute on function public.increment_website_enrichment_job_counters(uuid, int, int, int)
  to service_role;

comment on function public.increment_website_enrichment_job_counters is
  'Atomic +N для website_enrichment_jobs.processed/success_count/error_count. Используется coordinator''ом после flush''а batch''а из buffer''а. Защищён от race с legacy websiteEnrichmentWorker.flushProgress (тот пишет absolute SET, и в худшем случае инкременты перезатираются на COUNT-снапшот queue — данные не теряются).';
