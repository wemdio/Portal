-- Lead handoff to client: per-project CC email + a handoff "legend" the AI adapts.
-- When an interested lead is found, the worker generates a reply from this legend
-- and posts it to Telegram with a Send button (pressed by the responsible specialist),
-- which replies into the lead's thread with handoff_email in CC.
-- Empty handoff_email = auto-handoff disabled for the project (opt-in).

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS handoff_email text,
  ADD COLUMN IF NOT EXISTS handoff_legend text;

COMMENT ON COLUMN public.projects.handoff_email IS
  'Client email CC''d when an interested lead is handed off. Empty = auto-handoff off.';
COMMENT ON COLUMN public.projects.handoff_legend IS
  'Specialist-authored handoff story; the AI adapts it to the lead''s reply context.';
