insert into public.reglament_documents (
  slug,
  title,
  status,
  content,
  created_at,
  updated_at,
  published_at
)
values (
  'reglament',
  'Регламент',
  'published',
  '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb,
  now(),
  now(),
  now()
)
on conflict (slug) do nothing;
