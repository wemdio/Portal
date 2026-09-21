-- Optional Telegram mention for the employee assigned in projects.manager.
-- OFF by default so deployment does not change notification recipients for
-- existing projects until an administrator explicitly enables it.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS tag_project_lead_in_telegram boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.projects.tag_project_lead_in_telegram IS
  'When true, mention the project Lead (PM) alongside the specialist in new Instantly lead Telegram cards.';
