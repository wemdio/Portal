-- Update KB categories:
--   old: chat_export, transcript, product_info, sales_script, faq, other
--   new: sales_chats, video_transcripts, product_info, client_chats, other

-- Migrate existing data to new categories
update public.kb_documents set category = 'sales_chats' where category = 'chat_export';
update public.kb_documents set category = 'video_transcripts' where category = 'transcript';
update public.kb_documents set category = 'client_chats' where category = 'sales_script';
update public.kb_documents set category = 'other' where category = 'faq';

-- Drop old constraint and add new one
alter table public.kb_documents drop constraint if exists kb_documents_category_check;
alter table public.kb_documents add constraint kb_documents_category_check
  check (category in ('sales_chats', 'video_transcripts', 'product_info', 'client_chats', 'other'));
