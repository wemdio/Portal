-- Campaign attribution for self-signups.
--
-- The landing (outreachos.pro) stashes utm_* (+ referrer/landing/ts) in a
-- parent-domain cookie `oos_utm` (Domain=outreachos.pro) so the tags survive the
-- cross-subdomain hop to app.outreachos.pro — both the direct landing→/signup
-- path and landing→/demo→…→«Зарегистрироваться». /api/signup reads that cookie
-- server-side and writes it here, so registrations can be attributed to outreach
-- campaigns (e.g. GROUP BY signup_utm->>'utm_campaign').
alter table public.profiles add column if not exists signup_utm jsonb;

comment on column public.profiles.signup_utm is
  'Campaign attribution captured at self-signup (utm_source/medium/campaign/term/content, referrer, landing, ts) from the landing parent-domain cookie oos_utm. Null for signups without campaign tags.';
