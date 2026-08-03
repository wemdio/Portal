-- Hypothesis Engine (Движок вертикалей): статус 'cancelled' для he_jobs —
-- отмена задач пользователем (POST /api/tools/hypothesis-engine/projects/[id]/cancel).
--
-- Сценарий: проект/цепочку/шаблон запустили по ошибке, воркер продолжает
-- жечь LLM API. Cancel переводит все pending/running джобы проекта в
-- 'cancelled': pending больше не клеймятся воркером, running обрываются
-- через AbortSignal в LLM-слое (см. setHeActiveJobSignal в llm.ts и
-- cancel-наблюдатель в worker/hypothesisEngine.ts). Повторный запуск
-- research возможен: роут откатывает he_projects.status researching → draft.
-- Grant'ы не нужны — меняется только constraint.

alter table public.he_jobs
  drop constraint if exists he_jobs_status_check;

alter table public.he_jobs
  add constraint he_jobs_status_check
  check (status in ('pending','running','done','failed','cancelled'));
