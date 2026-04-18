-- Add specialist_user_id (proper FK) alongside the existing text specialist field.
-- Auto-fill from existing text specialist by matching profiles.full_name or email local part.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS specialist_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_specialist_user_id
  ON public.projects (specialist_user_id)
  WHERE specialist_user_id IS NOT NULL;

-- Best-effort backfill: match specialist text to profiles
UPDATE public.projects p
SET specialist_user_id = matched.id
FROM (
  SELECT id, full_name, split_part(email, '@', 1) AS email_local
  FROM public.profiles
) matched
WHERE p.specialist IS NOT NULL
  AND p.specialist_user_id IS NULL
  AND (
    lower(trim(p.specialist)) = lower(trim(matched.full_name))
    OR lower(trim(p.specialist)) = lower(trim(matched.email_local))
  );
