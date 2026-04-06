ALTER TABLE public.tasks
  ALTER COLUMN deadline TYPE timestamptz USING deadline::timestamptz;
