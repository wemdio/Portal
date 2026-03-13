-- CIS Lead Finder: deduplicate aggregated contacts

create unique index if not exists idx_company_contacts_dedup
  on public.company_contacts(user_id, company_id, full_name, coalesce(channel_phone, ''), coalesce(channel_tg_username, ''), coalesce(channel_email, ''));

