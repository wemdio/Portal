-- 015_insights_mv_state.sql — состояние авто-рефреша материализованных вьюх.
-- Чтобы фича campaign-insights деплоилась ТОЛЬКО кодом приложения (мерж+редеплой,
-- без ручных шагов на проде), рефреш mv_subject_ab_within_campaign делает сам
-- API-роут по требованию: атомарный claim здесь не даёт нескольким запросам
-- запустить REFRESH одновременно (см. refreshAbIfStale в src/lib/instantlyDataset.ts).
CREATE TABLE IF NOT EXISTS insights_mv_state (
  name          text PRIMARY KEY,
  refreshed_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE insights_mv_state IS 'Когда последний раз обновляли материализованную вьюху. refreshAbIfStale() атомарно «занимает» рефреш: UPDATE ... WHERE refreshed_at < now()-interval даёт ровно одному запросу право запустить REFRESH MATERIALIZED VIEW CONCURRENTLY.';

INSERT INTO insights_mv_state (name, refreshed_at)
VALUES ('mv_subject_ab_within_campaign', now())
ON CONFLICT (name) DO NOTHING;
