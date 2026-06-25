-- Lead capture now has more than one source (the hero "Обсудить задачу" contact
-- form; later possibly others). Carry which source produced the lead, plus the
-- company name and an optional free-text message from the contact form.
--
-- Written ONLY by the public /api/demo-lead route via the service-role client.
-- No GRANT needed: 20260625_0001 already did `grant all on public.demo_leads to
-- service_role`, which covers columns added later. RLS stays ops-only.

alter table public.demo_leads add column if not exists source  text;
alter table public.demo_leads add column if not exists company text;
alter table public.demo_leads add column if not exists message text;
