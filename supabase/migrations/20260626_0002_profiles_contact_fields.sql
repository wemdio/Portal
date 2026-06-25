-- Self-signup now collects company / phone / telegram (in addition to full_name,
-- which already exists on profiles). Store them on the profile so sales has the
-- prospect's contact details. Written by /api/signup via the service-role client;
-- the user can read their own profile (existing profiles RLS covers new columns).
-- profiles is a pre-existing table (20260204_0002), so no GRANT lint applies.

alter table public.profiles add column if not exists company  text;
alter table public.profiles add column if not exists phone    text;
alter table public.profiles add column if not exists telegram text;
