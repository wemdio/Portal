-- Флаг: разрешить live-добор из «базы баз» прямо в cron-прогоне.
--
-- По умолчанию ВЫКЛ. Раньше cron, не набрав daily_target из HH + кэша, тянул
-- сырые домены из companies_directory и скорил их Mailganer'ом на лету. Но
-- ~94.6% доменов базы получают score=0 (нет SPF) → их НЕ скрейпят: они лишь
-- раздували new_count и жгли Mailganer-вызовы (и были одной из причин OOM на
-- больших прогонах).
--
-- Теперь фоновый скорер (background_scorer_state) наполняет общий кэш
-- активными доменами 24/7, а cron берёт готовые score>0 из кэша
-- (fetchTopUpFromCache). Live-путь оставлен как аварийный fallback под флагом —
-- включать вручную, если кэш временно не покрывает спрос.

ALTER TABLE public.client_auto_pipeline_configs
  ADD COLUMN IF NOT EXISTS base_of_bases_live_fallback boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.client_auto_pipeline_configs.base_of_bases_live_fallback IS
  'Разрешить live-скоринг сырых доменов базы баз в cron (легаси). По умолчанию false — cron берёт активные домены из кэша, который наполняет фоновый скорер.';
