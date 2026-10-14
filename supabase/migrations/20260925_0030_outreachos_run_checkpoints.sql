-- Контрольные точки ежедневного прогона OutreachOS (инцидент 23–24.09.2026).
-- Деплой пересоздаёт portal-worker-hh и молча убивает exec'нутый прогон: лог
-- обрывается, строка outreachos_pipeline_runs навсегда висит в `running`, а
-- уже готовое задание конструктора никто не заливает. Сторож
-- (worker/outreachosWatchdogCron.ts) продолжает такой прогон с последней точки:
--   constructor — HH собран, задание конструктора создано (или HH пуст);
--   upload      — лиды собраны, seen ещё не записан, заливки не было.
-- Отдельная таблица, а не колонки runs: CREATE TABLE не ждёт блокировку pg_dump.
CREATE TABLE IF NOT EXISTS public.outreachos_run_checkpoints (
  run_id uuid PRIMARY KEY REFERENCES public.outreachos_pipeline_runs(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('constructor', 'upload')),
  payload jsonb NOT NULL,
  resume_attempts integer NOT NULL DEFAULT 0 CHECK (resume_attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.outreachos_run_checkpoints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outreachos_run_checkpoints_service_role ON public.outreachos_run_checkpoints;
CREATE POLICY outreachos_run_checkpoints_service_role ON public.outreachos_run_checkpoints
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.outreachos_run_checkpoints FROM public, anon, authenticated;
GRANT ALL ON public.outreachos_run_checkpoints TO service_role, postgres;

COMMENT ON TABLE public.outreachos_run_checkpoints IS
  'Точка продолжения прогона OutreachOS после гибели процесса (деплой). Пишет pipelineRunner, читает сторож outreachosWatchdogCron. Строка удаляется при штатном завершении прогона; брошенные чистятся через 7 дней.';
COMMENT ON COLUMN public.outreachos_run_checkpoints.payload IS
  'Снимок состояния фазы (версия в payload.version). constructor: счётчики HH, base_job_id, сжатый список новых работодателей и домены батча. upload: лиды, строки seen и состояние 2GIS.';
COMMENT ON COLUMN public.outreachos_run_checkpoints.resume_attempts IS
  'Сколько раз сторож уже продолжал прогон. Меняется сравнением со старым значением, чтобы два сторожа не взяли один прогон.';

NOTIFY pgrst, 'reload schema';
