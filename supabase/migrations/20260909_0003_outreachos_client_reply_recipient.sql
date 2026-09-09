-- OutreachOS: the campaigns belong to a managed project, but that project
-- had no canonical client. Managed-project DM routing intentionally does not
-- infer ownership from client_instantly_access (visibility is not ownership).
-- Reviewed 2026-09-09: this project has no description/tasks and belongs to
-- the same OutreachOS account as outreachos_pipeline_config (see incident doc).
-- Exact identities + NULL guard: never replace an existing client, infer other
-- project owners, or change environments without this reviewed account/config.
WITH repaired AS (
  UPDATE public.projects AS project
  SET client_user_id = config.client_user_id,
      updated_at = now()
  FROM public.outreachos_pipeline_config AS config,
       public.profiles AS client
  WHERE project.id = '627a7a18-3bc7-4731-8ecc-185f42db6910'::uuid
    AND project.client = 'OutreachOS'
    AND project.client_user_id IS NULL
    AND config.id = 1
    AND config.client_user_id = '1a64fcda-e477-46fb-983b-a2648b89881d'::uuid
    AND client.id = config.client_user_id
    AND client.email = 'outreachos@test.ru'
    AND client.role = 'client'
  RETURNING project.id, project.client_user_id
)
INSERT INTO public.application_logs (level, source, event, message, context)
SELECT 'info', 'audit', 'client-replies.routing.repaired',
       'Linked OutreachOS project to its verified client account',
       jsonb_build_object('projectId', id, 'clientUserId', client_user_id)
FROM repaired;
