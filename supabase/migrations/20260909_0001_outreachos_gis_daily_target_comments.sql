-- OutreachOS: отдельная цель контактов GIS сверх HH.
-- Поведение меняет worker; существующие значения конфига и лимиты не меняем.
COMMENT ON COLUMN public.outreachos_pipeline_config.gis_topup_enabled IS
  '2GIS: мастер-выключатель ежедневного добора сверх результата HH, в том числе при пустом HH.';

COMMENT ON COLUMN public.outreachos_pipeline_config.gis_topup_target_appended IS
  'Цель контактов из 2GIS за прогон, сверх HH; суммарно по кампаниям A+B. Один батч ограничен gis_topup_daily_cap, фактический выход зависит от обработки и дедупов.';

COMMENT ON COLUMN public.outreachos_pipeline_runs.gis_pulled IS
  '2GIS: уникальных карточек/доменов просмотрено до кросс-дедупа; может превышать лимит компаний-кандидатов gis_topup_daily_cap.';
