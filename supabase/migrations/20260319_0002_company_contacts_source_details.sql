-- Add source_details jsonb to company_contacts for per-field source tracking.
-- Format: { "phone": "сайт компании", "email": "Perplexity поиск", "tg": "MTProto (наш софт)", ... }

alter table public.company_contacts
  add column if not exists source_details jsonb default '{}'::jsonb;

comment on column public.company_contacts.source_details is
  'Per-field source tracking: keys are field names (phone, email, tg, name, title, linkedin, etc.), values describe the data source';
