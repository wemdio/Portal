-- Personal default deadline preference for task creation
alter table public.profiles
  add column if not exists task_deadline_default_enabled boolean not null default false,
  add column if not exists task_deadline_default_mode text not null default 'tomorrow',
  add column if not exists task_deadline_default_at timestamptz null,
  add column if not exists task_deadline_default_time text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_task_deadline_default_mode_check'
  ) then
    alter table public.profiles
      add constraint profiles_task_deadline_default_mode_check
      check (task_deadline_default_mode in ('tomorrow', 'fixed'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_task_deadline_default_time_check'
  ) then
    alter table public.profiles
      add constraint profiles_task_deadline_default_time_check
      check (
        task_deadline_default_time is null
        or task_deadline_default_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      );
  end if;
end $$;
