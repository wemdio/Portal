-- Campaign attribution for landing leads.
--
-- The English landing (outreachos.xyz) sends the visit's utm_source/medium/campaign/
-- term/content, the outside referrer and the landing URL as extra form fields with
-- the lead; when the utm_* come from an earlier visit (the landing's 30-day oos_utm
-- cookie), it also sends `ts`, the time of that visit. /api/demo-lead cleans them and
-- stores the object here. The Referer header alone cannot carry it: the landing's
-- Referrer-Policy cuts it to the origin, which stays in demo_leads.referrer as before.
-- Null for leads without attribution.
--
-- Written ONLY by the public /api/demo-lead route via the service-role client.
-- No GRANT needed: 20260625_0001 already did `grant all on public.demo_leads to
-- service_role`, which covers columns added later. RLS stays ops-only.
-- The route keeps storing leads (without utm) until this column exists.

alter table public.demo_leads add column if not exists utm jsonb;

comment on column public.demo_leads.utm is
  'Campaign attribution sent with the lead by the landing form (utm_source/medium/campaign/term/content, referrer = outside site, landing = arrival URL, ts = time of the earlier visit the utm_* come from, only when they come from one). Null for leads without attribution.';
