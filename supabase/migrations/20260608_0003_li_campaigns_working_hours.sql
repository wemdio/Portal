-- LinkedIn Outreach (v1): per-campaign working hours window.
--
-- Mirrors the v2 column on li2_campaigns (migration 20260608_0001). v1 is the
-- production tool, so the default here is intentionally "always on" — an
-- empty array means no restriction. Existing campaigns therefore keep their
-- current 24/7 behaviour. New campaigns get a real window from the UI form
-- default (09:00-18:00 MSK).
--
-- The runner reads these in lib/liOutreach/campaignRunner.ts::runCampaignTick
-- and early-returns when NOW falls outside the window. Compares local time
-- = UTC + timezone_offset against each "HH:MM-HH:MM" entry.
alter table public.li_campaigns
  add column if not exists working_hours   text[]  not null default '{}'::text[],
  add column if not exists timezone_offset integer not null default 0;

comment on column public.li_campaigns.working_hours is
  'Окна, в которые runner отправляет инвайты и сообщения. Формат "HH:MM-HH:MM", несколько окон через запятую (например, для перерыва на обед). Пустой массив = всегда работает (24/7).';
comment on column public.li_campaigns.timezone_offset is
  'Смещение от UTC в часах (3 для MSK). Используется для сравнения местного времени с working_hours.';
