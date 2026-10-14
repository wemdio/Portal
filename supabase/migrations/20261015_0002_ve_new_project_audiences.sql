-- Only the upgraded internal creation API stamps v1. Existing projects and
-- other creation paths stay legacy; no clock cutoff, backfill or DB default.
alter table public.ve_projects
  add column if not exists audience_generation_version smallint;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ve_projects'::regclass
      and conname = 've_projects_audience_generation_version_valid'
  ) then
    alter table public.ve_projects
      add constraint ve_projects_audience_generation_version_valid
      check (audience_generation_version is null or audience_generation_version = 1);
  end if;
end $$;

comment on column public.ve_projects.audience_generation_version is
  'Generation contract fixed at internal project creation: NULL = legacy, 1 = structured audience scopes. Never backfill existing projects.';
