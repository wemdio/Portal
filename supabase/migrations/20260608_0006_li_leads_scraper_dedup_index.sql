-- LinkedIn Outreach (v1): unique index for scraper deduplication.
--
-- scraperLogic.ts (search + reactions) calls
--   .upsert(..., { onConflict: 'user_id,lead_list_id,linkedin_id',
--                  ignoreDuplicates: true })
-- to skip leads that were already scraped into the same list. PostgREST
-- requires a real unique constraint/index matching the conflict target —
-- without one it returns
--   "there is no unique or exclusion constraint matching the
--    ON CONFLICT specification".
-- The scraper code awaited the upsert but never destructured `.error`, so
-- failures were silently swallowed and the progress counter still ticked up
-- per-item. Net effect: task reads `completed 10/10`, but no rows actually
-- land in li_leads. Confirmed in prod 2026-06-08 on a 10-lead run that
-- produced zero rows in list cc604763-…
--
-- The partial WHERE clause keeps NULL linkedin_id allowed multiple times —
-- the scraper inserts NULL when Unipile returned a profile without a
-- resolvable provider_id, and we don't want one such row to block all the
-- others. NULL list_id is naturally fine (Postgres treats NULL as
-- distinct-from-NULL in unique constraints), so a person can sit in
-- multiple lists at once. The constraint only blocks duplicates of
-- (same user, same list, same provider id) — which is the dedup we want.
create unique index if not exists li_leads_scraper_dedup_idx
  on public.li_leads (user_id, lead_list_id, linkedin_id)
  where linkedin_id is not null;
