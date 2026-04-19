-- Add email forwarding tracking fields to client_forwarded_leads.
-- forwarded_via: 'telegram' | 'email' | 'portal' (default null = telegram for existing rows)
-- client_email: the CC'd client email address when forwarding via email

ALTER TABLE public.client_forwarded_leads
  ADD COLUMN IF NOT EXISTS forwarded_via text;

ALTER TABLE public.client_forwarded_leads
  ADD COLUMN IF NOT EXISTS client_email text;

-- Ensure client_user_id is nullable (email-only forwards have no portal user)
ALTER TABLE public.client_forwarded_leads
  ALTER COLUMN client_user_id DROP NOT NULL;
