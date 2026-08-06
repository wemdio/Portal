-- Hypothesis Engine (Движок вертикалей): фактические метрики вертикали —
-- петля сверки прогноза с реальностью. После запуска шаблона в Instantly
-- reconciler (lib/hypothesisEngine/actualsReconcile.ts) подтягивает из
-- instantly_dataset фактические sent/replies по кампаниям запуска и пишет
-- сюда: вертикаль показывает «факт reply X%», а стадия hypotheses получает
-- калибровочные примеры «прогноз vs факт».
--
-- actual_reply_pct — reply rate запущенных кампаний вертикали (sent >= 100);
-- actual_sent — объём, на котором посчитан; actual_measured_at — штамп замера
-- (reconcile не чаще раза в сутки на вертикаль).

alter table public.he_verticals
  add column if not exists actual_reply_pct numeric(5,2);

alter table public.he_verticals
  add column if not exists actual_sent bigint;

alter table public.he_verticals
  add column if not exists actual_measured_at timestamptz;

comment on column public.he_verticals.actual_reply_pct is
  'Фактический reply% запущенных кампаний вертикали (instantly_dataset), null — данных мало/нет.';
comment on column public.he_verticals.actual_sent is
  'Отправок в запущенных кампаниях вертикали на момент замера.';
comment on column public.he_verticals.actual_measured_at is
  'Когда фактические метрики последний раз подтягивались из датасета.';
