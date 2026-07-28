-- Hypothesis Engine (Движок вертикалей): добавляем стадию 'dossier' в
-- CHECK he_jobs.stage.
--
-- Стадия dossier (app/src/lib/hypothesisEngine/stages/dossier.ts) собирает
-- объективное досье вертикали (he_vertical_dossiers) и ставит job'ы в
-- he_jobs со stage='dossier'; со старым списком стадий каждый insert падает
-- на check-ограничении. Пересоздаём ограничение полным списком стадий.
-- Grant'ы не нужны — меняется только constraint.

alter table public.he_jobs
  drop constraint if exists he_jobs_stage_check;

alter table public.he_jobs
  add constraint he_jobs_stage_check
  check (stage in ('site_profile','competitors','brand_cloud','hypotheses','evidence','clustering','chain','vocab','base_analyze','template','dossier'));
