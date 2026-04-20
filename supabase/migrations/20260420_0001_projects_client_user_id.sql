-- Привязка проекта к клиенту-пользователю.
--
-- В колонке projects.client сейчас лежит произвольный текст (имя клиента),
-- этого не хватает чтобы фильтровать проекты в ЛК клиента — там нужен
-- надёжный FK на профиль. ON DELETE SET NULL — проект остаётся в системе,
-- даже если у клиента удалили пользователя.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS client_user_id uuid
    REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_client_user_id
  ON public.projects(client_user_id)
  WHERE client_user_id IS NOT NULL;

COMMENT ON COLUMN public.projects.client_user_id IS
  'Profile of the client this project belongs to. Used to scope /client/projects in the customer portal.';

-- RLS read-policy для роли client.
--
-- На таблицах projects/tasks уже есть открытая политика *_all (USING true).
-- Service_role её игнорирует, так что для серверного кода ничего не меняется.
-- Но если когда-либо клиентский UI начнёт ходить напрямую с anon-ключом и JWT
-- клиента (а не через service_role API), эта политика гарантирует, что он
-- увидит только свои проекты. Защита в глубину.
DROP POLICY IF EXISTS "projects_client_read_own" ON public.projects;
CREATE POLICY "projects_client_read_own"
  ON public.projects
  FOR SELECT
  TO authenticated
  USING (
    client_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role <> 'client'
    )
  );

DROP POLICY IF EXISTS "tasks_client_read_own" ON public.tasks;
CREATE POLICY "tasks_client_read_own"
  ON public.tasks
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects pr
      WHERE pr.id = public.tasks.project_id
        AND pr.client_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role <> 'client'
    )
  );
