-- 013_outcomes_and_registry.sql — LLM-метки исходов ответов + реестр рекомендаций.
-- Контекст: wiki/analyses/2026-06-11-dataset-objectivity-audit.md (приоритетные фиксы 3 и 5).

-- ── reply_outcome_labels: версионированные LLM-метки исходов ───────────────
-- Покрывает дыру "исход известен лишь у 30-38% ответов": батч-классификация
-- всех (campaign, lead) реплаев по единой рубрике. Источник метки версионирован —
-- при смене модели/рубрики старые метки НЕ перезаписываются втихую.
CREATE TABLE IF NOT EXISTS reply_outcome_labels (
  campaign_id    text        NOT NULL,
  lead_id        text        NOT NULL,
  label          text        NOT NULL CHECK (label IN
    ('interested','referral','question','objection','not_interested',
     'unsubscribe','auto_reply','wrong_person','other')),
  confidence     numeric,
  model          text        NOT NULL,
  rubric_version text        NOT NULL,
  body_hash      text,
  classified_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, lead_id)
);
COMMENT ON TABLE reply_outcome_labels IS 'LLM-классификация исходов ответов лидов: 1 строка на (campaign, lead), по самому содержательному телу ответа пары. Рубрика v1: interested/referral = позитив; question/objection = середина; not_interested/unsubscribe = отказ; auto_reply/wrong_person/other = шум. Заполняется backfill-reply-labels.mjs.';
COMMENT ON COLUMN reply_outcome_labels.label IS 'interested=явный интерес; referral=дали контакт ЛПР (ценно!); question=уточняют без интереса; objection=возражение не категоричное; not_interested=отказ; unsubscribe=требование прекратить; auto_reply=автоответ/OOO; wrong_person=не туда; other=мусор.';
COMMENT ON COLUMN reply_outcome_labels.rubric_version IS 'Версия промпта-рубрики (v1, v2...). При смене рубрики метки пересчитываются НОВОЙ версией, сравнение версий — через классификацию выборки обеими.';

-- ── v_reply_outcomes: канонический исход ответа (LLM ∪ Instantly) ───────────
-- Правило: LLM-метка первична (единая рубрика на всю историю);
-- где LLM ещё не прошёл — fallback на санированный i_status Instantly.
CREATE OR REPLACE VIEW v_reply_outcomes AS
SELECT
  f.campaign_id,
  f.lead_id,
  f.first_reply_at,
  f.reply_rows,
  l.label                                   AS llm_label,
  l.confidence                              AS llm_confidence,
  f.best_i_status,
  f.interested                              AS instantly_interested,
  COALESCE(
    l.label IN ('interested','referral'),
    f.interested,
    false
  )                                         AS positive,
  CASE WHEN l.label IS NOT NULL THEN 'llm:' || l.rubric_version
       WHEN f.labeled THEN 'instantly'
       ELSE NULL END                         AS label_source
FROM v_reply_facts f
LEFT JOIN reply_outcome_labels l
  ON l.campaign_id = f.campaign_id AND l.lead_id = f.lead_id;
COMMENT ON VIEW v_reply_outcomes IS 'Канонический исход ответа: positive = LLM(interested|referral), при отсутствии LLM-метки — Instantly interested. label_source показывает происхождение. Для метрик качества кампании использовать ЭТО, не сырые i_status.';

-- ── insight_recommendations: реестр рекомендаций (фальсифицируемость) ───────
-- Каждый совет фичи логируется сюда с датой замера. Совет без замера к
-- planned_readout_at протухает (expired) — система не приписывает себе чужие успехи.
CREATE TABLE IF NOT EXISTS insight_recommendations (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  campaign_id        text,
  client             text,
  grade              text        NOT NULL CHECK (grade IN ('A','B','C')),
  finding            text        NOT NULL,
  recommendation     text        NOT NULL,
  evidence           jsonb,
  status             text        NOT NULL DEFAULT 'issued' CHECK (status IN
    ('issued','accepted','rejected','measured','expired')),
  planned_readout_at date,
  readout_result     text,
  readout_at         timestamptz,
  source             text        NOT NULL DEFAULT 'campaign-health'
);
COMMENT ON TABLE insight_recommendations IS 'Реестр рекомендаций фичи campaign-insights: совет -> принят/отклонён -> замер эффекта. Грейды: A=причинный (within-campaign A/B / прямой факт), B=корреляционный с контролем, C=эвристика. Совет без замера к planned_readout_at помечается expired на weekly review. Запрещено удалять строки — только статусы.';
COMMENT ON COLUMN insight_recommendations.evidence IS 'Числа, на которых основан совет: {rates, ci, p_value, windows, n}. Обязателен для grade A/B.';
