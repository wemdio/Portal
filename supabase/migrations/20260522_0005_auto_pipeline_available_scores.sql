-- Добавляем список возможных значений score, которые может вернуть endpoint
-- клиента. Это «словарь скорингов» — клиент сам пишет цепочку под каждое
-- значение в UI /client/auto-pipeline/setup, а оркестратор матчит score
-- из endpoint'а ровно с одним bucket (score_min === score_max).
--
-- Заполняется админом одноразово (SQL пока, UI отложен):
--
--   UPDATE public.client_auto_pipeline_configs
--   SET available_scores = '[0, 100, 500, 1000]'::jsonb
--   WHERE client_user_id = '<uuid>';

ALTER TABLE public.client_auto_pipeline_configs
  ADD COLUMN IF NOT EXISTS available_scores jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.client_auto_pipeline_configs.available_scores IS
  'JSON-массив чисел: значения score, которые умеет возвращать endpoint клиента. На каждое значение клиент в /client/auto-pipeline/setup пишет свою цепочку. Заполняется админом — клиент только редактирует sequence для уже заданных значений.';
