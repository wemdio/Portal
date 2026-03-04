-- Allow anonymous users to read published reglament documents (public regulations page)
drop policy if exists reglament_documents_anon_select_published on public.reglament_documents;
create policy reglament_documents_anon_select_published
  on public.reglament_documents
  for select
  to anon
  using (status = 'published' and delete_at is null);
