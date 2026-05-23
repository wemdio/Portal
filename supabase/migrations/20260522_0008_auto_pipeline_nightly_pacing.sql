-- Ночное окно для распределения парсинга вместо burst в 07:00 МСК.
--
-- parse_pacing = 'burst':       один прогон ~35 минут (как сейчас)
-- parse_pacing = 'nightly':     растянуть на окно [start..end] UTC. Каждый
--                               employer обогащается с авто-расчётной паузой,
--                               чтобы вписаться в окно. Снижает мгновенную
--                               нагрузку на HH/Mailganer/целевые сайты с 4 RPS
--                               пиково до 0.3-0.5 RPS равномерно.
-- parse_pacing = 'continuous':  зарезервировано на будущее (24×7 daemon).
--
-- Default окно 21:00-03:00 UTC = 00:00-06:00 МСК — клиент видит готовые лиды
-- к утру первой смены.

ALTER TABLE public.client_auto_pipeline_configs
  ADD COLUMN IF NOT EXISTS parse_pacing text NOT NULL DEFAULT 'burst'
    CHECK (parse_pacing IN ('burst', 'nightly', 'continuous')),
  ADD COLUMN IF NOT EXISTS parse_window_start_utc smallint NOT NULL DEFAULT 21
    CHECK (parse_window_start_utc BETWEEN 0 AND 23),
  ADD COLUMN IF NOT EXISTS parse_window_end_utc smallint NOT NULL DEFAULT 3
    CHECK (parse_window_end_utc BETWEEN 0 AND 23);

COMMENT ON COLUMN public.client_auto_pipeline_configs.parse_pacing IS
  'burst — один прогон ~35 мин (классический); nightly — растянуть на окно [start..end] UTC; continuous — резерв.';
COMMENT ON COLUMN public.client_auto_pipeline_configs.parse_window_start_utc IS
  'Час UTC начала ночного окна (для parse_pacing=nightly). Default 21 = 00:00 МСК.';
COMMENT ON COLUMN public.client_auto_pipeline_configs.parse_window_end_utc IS
  'Час UTC конца ночного окна. Default 3 = 06:00 МСК. Если end < start, окно пересекает полночь.';
