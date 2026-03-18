-- Fix: replace expression-based unique index with a proper unique constraint
-- so that ON CONFLICT works in Supabase JS upsert calls.

drop index if exists public.idx_company_contacts_dedup;

alter table public.company_contacts
  drop constraint if exists company_contacts_user_company_name_uniq;

alter table public.company_contacts
  add constraint company_contacts_user_company_name_uniq
  unique (user_id, company_id, full_name);
