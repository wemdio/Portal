-- LinkedIn Outreach 2.0: per-campaign working hours window.
--
-- TG outreach defines `sleep_periods` — windows where the worker is OFF.
-- LinkedIn outreach inverts this: `working_hours` describes the window where
-- the worker IS allowed to send invites and reply. Per product requirement we
-- only message during user-defined business hours instead of pausing for
-- arbitrary "sleep" chunks.
--
-- Format mirrors TG sleep_periods: array of "HH:MM-HH:MM" strings (one or
-- more, in case the user wants a lunch break). timezone_offset is hours from
-- UTC (e.g. 3 for MSK) so the runtime can compare to local time.
alter table public.li2_campaigns
  add column if not exists working_hours   text[]  not null default array['09:00-18:00']::text[],
  add column if not exists timezone_offset integer not null default 0;
