-- Флаг авто-пайплайна для одного клиента (HH → endpoint клиента → Instantly).
-- Когда true: клиент видит только Дашборд/Ответы/Лиды/Отчёты/Поддержка,
-- а cron-задача /api/cron/auto-hh-pipeline каждое утро 07:00 МСК прогоняет
-- новые компании с HH через его scoring-эндпоинт и раскладывает лидов
-- по кампаниям-цепочкам.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS auto_pipeline_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.auto_pipeline_enabled IS
  'true — клиент работает в авто-режиме: HH-парсинг → scoring-endpoint → Instantly. Конфиг лежит в client_auto_pipeline_configs.';

CREATE INDEX IF NOT EXISTS idx_profiles_auto_pipeline_enabled
  ON public.profiles(auto_pipeline_enabled)
  WHERE auto_pipeline_enabled = true;
