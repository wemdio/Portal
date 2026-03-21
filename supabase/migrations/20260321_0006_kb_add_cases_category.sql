-- Add 'cases' category to kb_documents for case studies

alter table public.kb_documents drop constraint if exists kb_documents_category_check;
alter table public.kb_documents add constraint kb_documents_category_check
  check (category in ('sales_chats', 'video_transcripts', 'product_info', 'client_chats', 'other', 'cases'));
