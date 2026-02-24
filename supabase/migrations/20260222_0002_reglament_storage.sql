-- Storage bucket for reglament images
insert into storage.buckets (id, name, public)
values ('reglament-assets', 'reglament-assets', true)
on conflict (id) do update set public = excluded.public;

do $$
begin
  alter table storage.objects enable row level security;

  drop policy if exists reglament_assets_admin_insert on storage.objects;
  create policy reglament_assets_admin_insert
    on storage.objects
    for insert
    to authenticated
    with check (
      bucket_id = 'reglament-assets'
      and exists (
        select 1 from public.profiles
        where profiles.id = auth.uid()
          and profiles.role = 'admin'
      )
    );

  drop policy if exists reglament_assets_admin_update on storage.objects;
  create policy reglament_assets_admin_update
    on storage.objects
    for update
    to authenticated
    using (
      bucket_id = 'reglament-assets'
      and exists (
        select 1 from public.profiles
        where profiles.id = auth.uid()
          and profiles.role = 'admin'
      )
    )
    with check (
      bucket_id = 'reglament-assets'
      and exists (
        select 1 from public.profiles
        where profiles.id = auth.uid()
          and profiles.role = 'admin'
      )
    );

  drop policy if exists reglament_assets_admin_delete on storage.objects;
  create policy reglament_assets_admin_delete
    on storage.objects
    for delete
    to authenticated
    using (
      bucket_id = 'reglament-assets'
      and exists (
        select 1 from public.profiles
        where profiles.id = auth.uid()
          and profiles.role = 'admin'
      )
    );
exception
  when insufficient_privilege then
    raise notice 'Skipping storage.objects policies: insufficient privileges.';
end $$;
