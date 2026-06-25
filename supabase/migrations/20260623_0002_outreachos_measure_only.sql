-- Добавляет measure_only к outreachos_pipeline_config.
--
-- Зачем отдельной миграцией, хотя колонка есть в CREATE TABLE миграции 0001:
-- 0001 был ПРИМЕНЁН на проде ДО того, как в него добавили measure_only, а
-- применённые миграции по новой не гоняются (трекинг по имени файла). Поэтому
-- additive ALTER. IF NOT EXISTS — идемпотентно: на свежей БД, где 0001 уже
-- создал колонку, тут no-op.

ALTER TABLE public.outreachos_pipeline_config
  ADD COLUMN IF NOT EXISTS measure_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.outreachos_pipeline_config.measure_only IS
  'true: парс+конструктор+подсчёт valid БЕЗ заливки в Instantly и БЕЗ записи seen (замер воронки, повторяемо, campaign_id не нужен).';

-- PostgREST: перечитать схему, иначе колонка не видна через supabase-js (PostgREST)
-- до перезагрузки кэша схемы.
NOTIFY pgrst, 'reload schema';
