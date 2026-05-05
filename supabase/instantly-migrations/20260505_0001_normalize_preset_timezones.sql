-- 20260505_0001: Normalize legacy preset timezones to Instantly-allowed ids.
--
-- Instantly's API rejects timezones outside its fixed whitelist with HTTP 400:
--   "body/campaign_schedule/schedules/0/timezone must be equal to one of the allowed values"
--
-- The admin preset UI used to expose Europe/Moscow, Europe/Samara, Asia/Omsk,
-- Asia/Novosibirsk, Asia/Yakutsk, Asia/Vladivostok, Asia/Magadan, UTC — none of
-- which are in Instantly's whitelist. Existing presets in production still hold
-- those values. This migration rewrites them to the closest accepted equivalent
-- (same UTC offset where possible — see app/src/lib/clientLaunch/timezones.ts
-- for the mapping rationale).
--
-- The runtime normalizer in `buildCampaignPayloadFromPreset` already handles
-- this at request time, so this migration is purely hygiene — it keeps the DB
-- consistent with the admin dropdown so future reads/writes don't drift.

update public.client_campaign_presets
set    schedule_timezone = 'Europe/Kirov',
       updated_at        = now()
where  schedule_timezone = 'Europe/Moscow';

update public.client_campaign_presets
set    schedule_timezone = 'Europe/Astrakhan',
       updated_at        = now()
where  schedule_timezone = 'Europe/Samara';

update public.client_campaign_presets
set    schedule_timezone = 'Asia/Novokuznetsk',
       updated_at        = now()
where  schedule_timezone in ('Asia/Omsk', 'Asia/Novosibirsk');

update public.client_campaign_presets
set    schedule_timezone = 'Asia/Chita',
       updated_at        = now()
where  schedule_timezone = 'Asia/Yakutsk';

update public.client_campaign_presets
set    schedule_timezone = 'Asia/Sakhalin',
       updated_at        = now()
where  schedule_timezone in ('Asia/Vladivostok', 'Asia/Magadan');

update public.client_campaign_presets
set    schedule_timezone = 'Africa/Abidjan',
       updated_at        = now()
where  schedule_timezone = 'UTC';

-- Update the column default for fresh rows so new presets pick a valid id.
alter table public.client_campaign_presets
  alter column schedule_timezone set default 'Europe/Kirov';
