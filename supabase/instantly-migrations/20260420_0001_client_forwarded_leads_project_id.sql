-- Привязка пересланного лида к проекту клиента.
--
-- projects живёт в основной БД (supabaseAdmin), а client_forwarded_leads —
-- в Instantly DB (supabaseInstantly). Через границу баз FK сделать нельзя,
-- поэтому храним просто uuid + индекс. Целостность поддерживается на
-- уровне приложения (в момент пересылки лида клиенту).

ALTER TABLE public.client_forwarded_leads
  ADD COLUMN IF NOT EXISTS project_id uuid;

CREATE INDEX IF NOT EXISTS idx_client_forwarded_leads_project
  ON public.client_forwarded_leads(project_id)
  WHERE project_id IS NOT NULL;

COMMENT ON COLUMN public.client_forwarded_leads.project_id IS
  'Soft reference to public.projects.id in the main DB. Used for per-project leads count in the client portal.';
