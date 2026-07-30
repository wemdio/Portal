-- Hypothesis Engine (Движок вертикалей): живой прогресс стадий —
-- колонка he_jobs.progress.
--
-- Воркер на каждой итерации цикла стадии (evidence — по кандидату,
-- brand_cloud — по бренду, competitors — по конкуренту) пишет сюда
-- {done, total, label}, а UI шага «Исследование» показывает счётчик
-- вида «— 14/33 · проверяем гипотезу» вместо статичного спиннера.
-- Grant'ы не нужны — колонка наследует права таблицы he_jobs.

alter table public.he_jobs
  add column if not exists progress jsonb;

comment on column public.he_jobs.progress is
  'Живой прогресс стадии: {done, total, label}. Пишется воркером на каждой итерации цикла, читается UI.';
