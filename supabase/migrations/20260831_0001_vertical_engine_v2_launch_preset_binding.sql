-- Bind a Vertical Engine v2 project to one launch preset and the workspace
-- observed when that binding was first established. Existing projects remain
-- intentionally unbound and must be bound through the server-side workflow.

alter table public.ve_projects
  add column if not exists launch_preset_id uuid,
  add column if not exists launch_instantly_account_id text,
  add column if not exists launch_preset_bound_at timestamptz,
  add column if not exists launch_preset_bound_by uuid;

alter table public.ve_projects
  drop constraint if exists ve_projects_launch_preset_binding_all_or_none;

alter table public.ve_projects
  add constraint ve_projects_launch_preset_binding_all_or_none
  check (
    (
      launch_preset_id is null
      and launch_instantly_account_id is null
      and launch_preset_bound_at is null
      and launch_preset_bound_by is null
    )
    or
    (
      launch_preset_id is not null
      and launch_instantly_account_id is not null
      and launch_preset_bound_at is not null
      and launch_preset_bound_by is not null
      and nullif(btrim(launch_instantly_account_id), '') is not null
    )
  );

comment on column public.ve_projects.launch_preset_id is
  'Server-validated launch preset bound to this v2 project.';
comment on column public.ve_projects.launch_instantly_account_id is
  'Canonical workspace observed when the launch preset was bound.';
comment on column public.ve_projects.launch_preset_bound_at is
  'Timestamp of the first successful project-to-preset binding.';
comment on column public.ve_projects.launch_preset_bound_by is
  'Internal user who established the first project-to-preset binding.';
