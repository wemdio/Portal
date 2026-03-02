-- Archive: documents with delete_at set are hidden from main list and permanently deleted after delete_at.
alter table public.reglament_documents
  add column if not exists delete_at timestamptz;

comment on column public.reglament_documents.delete_at is 'When set, document is in archive; after this time it can be permanently deleted by cleanup job.';

create index if not exists idx_reglament_documents_delete_at
  on public.reglament_documents(delete_at)
  where delete_at is not null;
