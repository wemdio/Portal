-- A/B-сплит офферов OutreachOS: вторая кампания Instantly.
--
-- campaign_id_b = NULL → сплит выключен, все лиды в campaign_id (текущее
-- поведение). Задан → лиды делятся ~50/50 ДЕТЕРМИНИРОВАННО по домену компании
-- (hash % 2): все почты одной компании попадают в ОДНУ кампанию (одна компания
-- не должна получать два разных оффера), и при ретраях лид не мигрирует между
-- кампаниями. Тема/тайминги в кампаниях одинаковые, различаются только тела
-- писем — сравнение офферов по v_reply_outcomes per campaign_id.

ALTER TABLE public.outreachos_pipeline_config
  ADD COLUMN IF NOT EXISTS campaign_id_b text;

COMMENT ON COLUMN public.outreachos_pipeline_config.campaign_id_b IS
  'Вторая кампания Instantly для A/B-сплита офферов. NULL = сплит выключен (всё в campaign_id). Сплит 50/50 по hash домена компании.';

ALTER TABLE public.outreachos_pipeline_runs
  ADD COLUMN IF NOT EXISTS appended_b int;

COMMENT ON COLUMN public.outreachos_pipeline_runs.appended IS
  'Принято Instantly в кампанию A (campaign_id). При выключенном сплите — всё здесь.';
COMMENT ON COLUMN public.outreachos_pipeline_runs.appended_b IS
  'Принято Instantly в кампанию B (campaign_id_b). NULL/0 при выключенном сплите.';

NOTIFY pgrst, 'reload schema';
