-- Разбивка new_count прогона auto-pipeline по источникам: HH vs «база баз».
--
-- Оркестратор собирает fresh = [HH-работодатели + добор из базы баз]
-- (autoPipelineRunner.ts, шаг 3.5). До сих пор в журнал прогонов писался
-- только суммарный new_count. Эти две колонки разбивают его, чтобы дашборд
-- клиента показал «из HH: X / из базы баз: Y» — клиент видит, что обе базы
-- работают на его запуски.
--
-- new_from_hh + new_from_bob = new_count (для completed-прогонов). Источник
-- каждой строки уже хранится в seen_employers.source; здесь просто
-- денормализованный агрегат на уровне прогона для быстрого чтения дашбордом.

ALTER TABLE public.client_auto_pipeline_runs
  ADD COLUMN IF NOT EXISTS new_from_hh integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS new_from_bob integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.client_auto_pipeline_runs.new_from_hh IS
  'Сколько новых работодателей в прогоне пришло из HH.ru.';
COMMENT ON COLUMN public.client_auto_pipeline_runs.new_from_bob IS
  'Сколько новых пришло добором из «базы баз» (кэш + live BoB). Включается когда HH дал меньше daily_target_employers.';
