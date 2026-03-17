-- Add profile_links jsonb to company_contacts for social profile URLs
-- Format: { "linkedin": "https://...", "vk": "https://...", "telegram": "https://t.me/...", ... }

alter table public.company_contacts
  add column if not exists profile_links jsonb default '{}'::jsonb;

comment on column public.company_contacts.profile_links is 'Social profile URLs: linkedin, vk, telegram, facebook, twitter, ok, habr, instagram';
