-- Чёрный список ручных удалений кампаний из карточки проекта.
--
-- Зачем: проекты продлеваются на новые периоды, у каждого свои обязательства.
-- Кампании прошлого периода специалист удаляет из карточки проекта руками.
-- Но autoMatchCampaignsToProjects (text-match по client name + AI-fallback)
-- запускается на каждой синхронизации каталога и **снова** добавляет ту же
-- кампанию обратно — потому что её имя по-прежнему содержит имя клиента.
-- В результате удаление руками не работает: на следующей синке кампания
-- возвращается, и так каждый раз.
--
-- Решение — denylist. При DELETE из карточки кладём пару (project_id,
-- campaign_id) сюда. Авто-матчер при следующем прогоне читает таблицу
-- и пропускает эти пары. Если специалист потом руками добавит кампанию
-- обратно (POST), запись из denylist удаляется — это явная отмена решения.
--
-- Лежит в PolzaInstantlyDB (одна БД с project_instantly_campaigns).

CREATE TABLE IF NOT EXISTS public.project_instantly_campaigns_denylist (
  project_id uuid NOT NULL,
  campaign_id text NOT NULL,
  denied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_project_campaign_denylist_project
  ON public.project_instantly_campaigns_denylist (project_id);

ALTER TABLE public.project_instantly_campaigns_denylist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on project_campaign_denylist"
  ON public.project_instantly_campaigns_denylist;
CREATE POLICY "Service role full access on project_campaign_denylist"
  ON public.project_instantly_campaigns_denylist FOR ALL
  USING (true) WITH CHECK (true);
