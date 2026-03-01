-- Allow tasks without a project (e.g. personal/backlog tasks on board)
ALTER TABLE public.tasks
  ALTER COLUMN project_id DROP NOT NULL;

-- Keep referential integrity; when project is deleted, set task's project_id to null
ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_project_id_fkey;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
