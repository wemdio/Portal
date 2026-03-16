ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS deadline DATE;
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON public.tasks(deadline) WHERE deadline IS NOT NULL;
