-- Widen RLS UPDATE policies on li_accounts and li_campaigns so any team member
-- can edit accounts and campaigns others added. Background: the studio is a
-- small trusted team, and the "аккаунт/кампания другого специалиста, только
-- просмотр" state (introduced when we made accounts + campaigns visible
-- cross-specialist in a previous migration) has been more of a friction
-- source than a safety net — operators frequently need to fix a colleague's
-- prompt or proxy while the colleague is offline. Ownership is still tracked
-- via the INSERT policy (auth.uid() = user_id) so the UI can label who added
-- what for audit; DELETE stays owner-only as a safety guard against
-- destructive typos on a foreign row.
--
-- Companion code changes in this PR:
--   - accounts/[id]/route.ts PATCH: drop `.eq('user_id', auth.user.id)` on
--     the select so any authenticated user can PATCH the proxy.
--   - accounts/route.ts GET: stop nulling out `proxy_url` for non-owners —
--     the proxy is now editable by everyone, so hiding it in the read is
--     inconsistent with the write path.
--   - campaigns/[id]/route.ts PUT: drop the owner-only gate on select and
--     the `userOwnsAccount` guard on account reassignment (team-edit means
--     the whole team is trusted with cross-attaching).
--   - campaigns/[id]/{start,stop}/route.ts POST: drop the owner-only gate
--     on select — starting/stopping is part of "editing" the campaign.
--   - li-outreach/page.tsx: drop the "только просмотр" badges + hints,
--     replace the "👁 Посмотреть настройки" button with real Edit/Start/Stop
--     buttons on foreign campaigns, and unhide the proxy input on foreign
--     accounts. Delete buttons stay owner-only (mirrors the DELETE policy).

BEGIN;

drop policy if exists li_accounts_update_own on public.li_accounts;
create policy li_accounts_update_team
  on public.li_accounts for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists li_campaigns_update_own on public.li_campaigns;
create policy li_campaigns_update_team
  on public.li_campaigns for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

COMMIT;
