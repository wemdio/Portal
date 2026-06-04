-- Auto-pipeline run heartbeat — для быстрого детекта мёртвых прогонов + resume.
--
-- Добор выносится из portal-контейнера в отдельный воркер (worker-autopipeline)
-- с graceful-stop + авто-resume. Чтобы воркер быстро подбирал брошенный прогон
-- (OOM / SIGKILL / редеплой пересоздал контейнер), а не ждал 4-часового порога
-- closeStaleRuns по started_at — живой прогон бьёт heartbeat_at раз в ~90с.
-- closeStaleRuns закрывает 'running'-строки без свежего heartbeat (стейл > ~8
-- мин) как failed → воркер тут же перезапускает прогон. Resume безопасен:
-- seen_employers дедупит уже обработанных, а createLeads(skip_if_in_campaign)
-- идемпотентен → ни потерь, ни дублей.

ALTER TABLE public.client_auto_pipeline_runs
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

COMMENT ON COLUMN public.client_auto_pipeline_runs.heartbeat_at IS
  'Последний heartbeat живого прогона (~раз в 90с). NULL у старых строк. closeStaleRuns закрывает running без свежего heartbeat (стейл > 8 мин).';
