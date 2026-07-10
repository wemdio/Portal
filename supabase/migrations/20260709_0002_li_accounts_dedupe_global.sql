-- Deduplicate li_accounts rows and make unipile_account_id globally unique.
--
-- Background:
--   The original schema (20260320_0001) put a unique index on
--   (user_id, unipile_account_id), which was fine when every specialist
--   had their OWN Unipile workspace. In 2026-07 we moved to a single
--   shared Unipile workspace (see migration 20260708_0001 + code
--   commits 39a15425 / c6d7daa5), and now every specialist who hits
--   "Синхронизировать" creates their own row per LinkedIn account:
--
--     unipile_account_id=X, user_id=Егор
--     unipile_account_id=X, user_id=Ариша
--     unipile_account_id=X, user_id=Алексей
--     …
--
--   The Accounts tab shows the same LinkedIn account 3-4 times, and
--   picking the "right" one for a campaign / scrape becomes lottery.
--
-- This migration:
--   1. Repoints all li_leads.account_id and li_campaigns.account_id
--      references from duplicate rows to the surviving row (oldest per
--      unipile_account_id).
--   2. Backfills the survivor's proxy_url from any non-empty duplicate
--      (most recently updated wins).
--   3. Deletes duplicates.
--   4. Drops the old (user_id, unipile_account_id) unique index.
--   5. Creates a new unique index on unipile_account_id alone.
--
-- Companion code change: accounts/sync/route.ts stops upserting on
-- (user_id, unipile_account_id) and now upsert-by-unipile-only, preserving
-- the original inserter's user_id on updates.

BEGIN;

-- 1. Identify survivor per unipile_account_id (oldest by created_at, ties broken by id).
create temp table li_account_survivors on commit drop as
select distinct on (unipile_account_id) unipile_account_id, id as survivor_id
  from public.li_accounts
 order by unipile_account_id, created_at asc, id asc;

-- 2a. Repoint li_leads.account_id from duplicates to survivor.
update public.li_leads l
   set account_id = s.survivor_id
  from public.li_accounts a
  join li_account_survivors s using (unipile_account_id)
 where l.account_id = a.id
   and a.id <> s.survivor_id;

-- 2b. Repoint li_campaigns.account_id from duplicates to survivor.
update public.li_campaigns c
   set account_id = s.survivor_id
  from public.li_accounts a
  join li_account_survivors s using (unipile_account_id)
 where c.account_id = a.id
   and a.id <> s.survivor_id;

-- 3. Backfill proxy_url on survivor if it's empty and any duplicate has one.
--    Prefer the most-recently-updated non-empty value.
update public.li_accounts a
   set proxy_url = (
     select dup.proxy_url
       from public.li_accounts dup
      where dup.unipile_account_id = a.unipile_account_id
        and dup.id <> a.id
        and dup.proxy_url is not null
        and dup.proxy_url <> ''
      order by dup.updated_at desc nulls last, dup.created_at desc
      limit 1
   )
  from li_account_survivors s
 where a.id = s.survivor_id
   and (a.proxy_url is null or a.proxy_url = '');

-- 4. Delete duplicates.
delete from public.li_accounts
 where id not in (select survivor_id from li_account_survivors);

-- 5. Drop old composite unique index; add new global unique index.
drop index if exists public.idx_li_accounts_user_unipile;
create unique index if not exists idx_li_accounts_unipile_id_unique
  on public.li_accounts(unipile_account_id);

COMMIT;
