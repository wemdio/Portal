ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS contacts_obligation text,
  ADD COLUMN IF NOT EXISTS contacts_done text;
