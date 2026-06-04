-- Enrich claim: возвращать batch с РАЗНЫМИ доменами, а не подряд из одного.
--
-- Контекст. Per-domain throttle в enrich-worker'е = 1 (не больше одного
-- HTTP-запроса к одному сайту параллельно — анти-бан) при WORKER_BATCH_SIZE=15
-- даёт хвост = ~15 sequential URL'ов в худшем случае (~75 сек), когда CSV
-- пользователя содержит блок из одного домена и старый claim ORDER BY
-- created_at брал их подряд. С diverse-claim'ом эта же реплика возьмёт 1 URL
-- domain A + 1 URL domain B + … → 15 URL × ~5с (parallel) ≈ 5с на batch.
--
-- Подход: вычисляем grouping-ключ как первый сегмент url_normalized после
-- протокола (грубо «host»), и сортируем по DISTINCT ON, чтобы каждый
-- следующий выбранный URL был с НОВОГО хоста. Если по уникальным хостам
-- набирается < p_limit — добивает «вторыми по очереди» из тех же доменов.
--
-- Без новых индексов: GROUP BY на substring не критичен на наших объёмах
-- (queue в момент одного активного job'а редко > 50k pending row'ов; даже
-- full-scan дешевле, чем экономия hot-end latency).

create or replace function public.claim_website_enrichment_items(
  p_job_id uuid,
  p_limit  integer
)
returns setof public.website_enrichment_queue
language plpgsql
as $$
begin
  return query
  with candidates as (
    select id, url_normalized, created_at,
           -- Грубый host = первый «слова» после `://` до первого `/`.
           -- Для большинства url_normalized'ов (canon https://host/path) это
           -- ровно host. Если url_normalized невалиден — host пустой, такие
           -- items всё равно попадут в claim, просто без diverse-эффекта.
           coalesce(
             nullif(split_part(split_part(url_normalized, '://', 2), '/', 1), ''),
             url_normalized
           ) as host
      from public.website_enrichment_queue
     where job_id = p_job_id
       and status = 'pending'
  ),
  ranked as (
    -- На каждый host раздаём «слоты» 1..N по времени создания. Реплика берёт
    -- сначала по слоту 1 у каждого host'а (diverse batch), потом по слоту 2,
    -- и т.д. — если в очереди один доминирующий host и все остальные пусты,
    -- claim'ит этого доминирующего по 1 шт за круг → реплика возвращается
    -- быстро, остальные подбирают что вновь упало в pending.
    select id,
           row_number() over (partition by host order by created_at) as slot,
           host,
           created_at
      from candidates
  ),
  picked as (
    select id
      from ranked
     order by slot, host, created_at
     limit p_limit
     for update skip locked
  )
  update public.website_enrichment_queue q
     set status         = 'processing',
         started_at     = now(),
         updated_at     = now(),
         attempt_count  = q.attempt_count + 1
    from picked
   where q.id = picked.id
  returning q.*;
end;
$$;

comment on function public.claim_website_enrichment_items is
  'Returns a batch of pending items with hostname diversity: each round picks 1 URL per host before pulling a 2nd from the same host. Eliminates the long-tail symptom where a CSV imported with one big block of single-domain URLs caused one replica to chew through them sequentially while the other replicas idled.';
