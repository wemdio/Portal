-- Track WhatsApp registration status for phone numbers.
-- null = unchecked, true = registered, false = not registered

alter table public.company_contacts
  add column if not exists wa_registered boolean;

comment on column public.company_contacts.wa_registered is
  'WhatsApp registration status: null=unchecked, true=registered, false=not registered';
