-- Индустрии для HH-парсинга в auto-pipeline.
--
-- Каждая HH industry имеет независимый 2000-limit на /vacancies. Без фильтра
-- мы упираемся в один общий 2000-limit и видим только верхушку (~815 уникальных
-- компаний из ~96k вакансий за 24ч = 0.8% потока). Итерирование по 30 top-level
-- индустриям даёт пул 13-20k уникальных компаний.
--
-- jsonb-массив строк-id ('5', '7', '11', ...). Пустой массив = старое
-- поведение (один общий запрос без индустриального фильтра).

ALTER TABLE public.client_auto_pipeline_configs
  ADD COLUMN IF NOT EXISTS industries jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.client_auto_pipeline_configs.industries IS
  'HH industry id''ы для itrate по ним отдельными запросами. Пустой массив = один общий запрос без industry-фильтра.';
