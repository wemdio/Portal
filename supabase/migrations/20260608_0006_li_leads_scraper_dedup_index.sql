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
--
-- ── Pre-existing duplicates ────────────────────────────────────────────────
-- Tables that predate this index already contain duplicate rows for
-- (user_id, lead_list_id, linkedin_id), so `create unique index` fails with
--   23505 "could not create unique index ... Key (...) is duplicated".
-- We must collapse each duplicate group to a single row first.
--
-- Picking which row survives matters: li_campaign_leads.lead_id references
-- li_leads(id) ON DELETE CASCADE, so deleting a lead that a campaign points at
-- silently destroys that lead's campaign progress. We therefore keep, per
-- group, the row that:
--   1. is referenced by li_campaign_leads (carries real outreach progress),
--   2. then has the most-advanced funnel status,
--   3. then was updated/active most recently,
--   4. ctid as a final deterministic tiebreak.
-- A guard below hard-aborts the migration if any row we are about to delete
-- still carries campaign progress — i.e. a group has progress on more than one
-- row and a plain delete would lose data. On the dataset this was written
-- against no such group exists (the delete is lossless); the guard exists so a
-- differently-shaped dataset (e.g. prod) fails loudly instead of cascading
-- progress away. Resolve such groups by hand before re-running.

-- 1. Identify the losers (every row in a duplicate group except the survivor).
--    `on commit drop` ties the temp table to the migration's own transaction
--    (ensureDatabase.js wraps each file in begin/commit).
create temp table li_leads_dedup_losers on commit drop as
with ranked as (
  select
    l.id,
    exists (select 1 from public.li_campaign_leads cl where cl.lead_id = l.id)
      as has_progress,
    row_number() over (
      partition by l.user_id, l.lead_list_id, l.linkedin_id
      order by
        exists (select 1 from public.li_campaign_leads cl2 where cl2.lead_id = l.id) desc,
        case l.status
          when 'completed'       then 6
          when 'replied'         then 5
          when 'messaged'        then 4
          when 'connected'       then 3
          when 'already_invited' then 2
          when 'invited'         then 1
          else 0
        end desc,
        l.updated_at desc,
        l.last_activity desc nulls last,
        l.ctid
    ) as rn
  from public.li_leads l
  where l.linkedin_id is not null
    and l.lead_list_id is not null
)
select id, has_progress
from ranked
where rn > 1;

-- 2. Safety guard: never cascade-delete campaign progress. If any loser is
--    still referenced by li_campaign_leads, abort the whole migration.
do $$
declare
  blocked int;
begin
  select count(*) into blocked
  from li_leads_dedup_losers
  where has_progress;

  if blocked > 0 then
    raise exception
      'li_leads dedup aborted: % duplicate row(s) slated for deletion still carry li_campaign_leads progress (ON DELETE CASCADE would destroy it). A duplicate group has campaign progress on more than one row — resolve those by hand before adding the unique index.', blocked;
  end if;
end $$;

-- 3. Collapse each duplicate group to its survivor.
delete from public.li_leads l
using li_leads_dedup_losers d
where l.id = d.id;

-- 4. Now the unique index can be built.
create unique index if not exists li_leads_scraper_dedup_idx
  on public.li_leads (user_id, lead_list_id, linkedin_id)
  where linkedin_id is not null;
