-- Per-domain кэш score'ов от Mailganer.
--
-- Раньше каждый cron-прогон auto-pipeline дёргал Mailganer для всех 11k+
-- employer'ов — даже если домен уже скорили вчера/неделю назад. Это самый
-- долгий этап прогона (~37 минут из 2.5 часов).
--
-- Теперь:
--   1. enrichEmployers сначала смотрит в этот кэш
--   2. Если score уже известен → берёт оттуда мгновенно (один SELECT)
--   3. Если нет → дёргает Mailganer + INSERT'ит результат для будущих прогонов
--
-- Кэш per-domain (не per-employer): один домен может быть у нескольких
-- работодателей (например, ИП с разными именами но одним сайтом). Score
-- зависит от домена, не от employer.
--
-- TTL: бессрочно. Score деливерабилитет почти не меняется (SPF/DKIM/MX
-- стабильны годами). Если когда-нибудь понадобится перескорить —
-- TRUNCATE TABLE mailganer_domain_scores; следующие прогоны заполнят
-- заново.

CREATE TABLE IF NOT EXISTS public.mailganer_domain_scores (
  -- Нормализованный домен (без www., нижний регистр) — натуральный PK.
  domain text PRIMARY KEY,
  score numeric,                              -- 0 / 5000 / 1015022 / NULL если endpoint вернул ошибку
  spf text,
  rating text,                                -- D / C / B / A — буквенная оценка от Mailganer
  raw jsonb,                                  -- полный ответ для отладки
  scored_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'cron'
    CHECK (source IN ('cron', 'background', 'manual'))
);

-- Быстрая выборка «дай N активных доменов из кэша» — для будущего BoB-добора
-- по кэшу (Iter 3).
CREATE INDEX IF NOT EXISTS idx_mailganer_active_domains
  ON public.mailganer_domain_scores (scored_at DESC)
  WHERE score > 0;

COMMENT ON TABLE public.mailganer_domain_scores IS
  'Per-domain кэш Mailganer score (бессрочный). Заполняется по ходу cron-прогонов и фонового скорера.';
COMMENT ON COLUMN public.mailganer_domain_scores.source IS
  'cron — дёрнул auto-pipeline cron; background — фоновый BoB scorer; manual — через UI/SQL.';

-- RLS — только service role
ALTER TABLE public.mailganer_domain_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on mailganer cache" ON public.mailganer_domain_scores;
CREATE POLICY "Service role full access on mailganer cache"
  ON public.mailganer_domain_scores
  FOR ALL
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.mailganer_domain_scores TO service_role;
