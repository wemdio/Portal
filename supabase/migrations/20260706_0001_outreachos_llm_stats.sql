-- LLM-отсев B2C должен быть виден в журнале прогонов, а не только в stdout-логе:
-- без этих колонок разница valid_contacts↔appended неотличима от отказов
-- Instantly, а молчаливая деградация модели (шум 90%) незаметна из БД.
ALTER TABLE outreachos_pipeline_runs
  ADD COLUMN IF NOT EXISTS llm_noise integer,
  ADD COLUMN IF NOT EXISTS llm_kept integer,
  ADD COLUMN IF NOT EXISTS llm_failed_batches integer,
  ADD COLUMN IF NOT EXISTS llm_guard_tripped boolean;

COMMENT ON COLUMN outreachos_pipeline_runs.llm_noise IS 'Компаний отсеяно LLM-фильтром (после рефьюта)';
COMMENT ON COLUMN outreachos_pipeline_runs.llm_kept IS 'Лидов осталось после LLM-отсева (valid_contacts - шумовые)';
COMMENT ON COLUMN outreachos_pipeline_runs.llm_failed_batches IS 'Батчей классификации без фильтрации (fail-open)';
COMMENT ON COLUMN outreachos_pipeline_runs.llm_guard_tripped IS 'Сработал предохранитель (шум >50% или ступень-2 не отработала) — фильтр отключён на прогон';
