-- 014_mv_subject_ab.sql — материализованная A/B-вьюха для живого API.
-- v_subject_ab_within_campaign тянет v_subject_performance по ВСЕМУ воркспейсу
-- (~4с даже scoped по campaign_id — фильтр не пушится вглубь). Для панели на
-- странице «Проекты» это слишком медленно. A/B — медленно меняющийся причинный
-- результат (накопленные отправки), поэтому ночного пересчёта достаточно.
-- Рефреш повесить в sync.mjs: REFRESH MATERIALIZED VIEW CONCURRENTLY mv_subject_ab_within_campaign;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_subject_ab_within_campaign AS
SELECT * FROM v_subject_ab_within_campaign;

COMMENT ON MATERIALIZED VIEW mv_subject_ab_within_campaign IS
  'Материализованный снимок v_subject_ab_within_campaign для быстрых scoped-запросов из API проекта. Рефреш ночью в sync.mjs (REFRESH MATERIALIZED VIEW CONCURRENTLY). Семантика — как у исходной вьюхи (within-campaign A/B тем).';

-- индекс под scoped-доступ из билдера (campaign_id = ANY(...)) и под CONCURRENTLY-рефреш (нужен UNIQUE)
CREATE UNIQUE INDEX IF NOT EXISTS mv_subject_ab_pk
  ON mv_subject_ab_within_campaign (campaign_id, step_n, variant_n);
