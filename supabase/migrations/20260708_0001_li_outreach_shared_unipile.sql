-- Data-only cleanup: deprecate BYOK (per-user Unipile DSN/api_key/proxy) in li_settings.
--
-- Background:
--   li_settings was designed per-user because outreach was originally meant to
--   support many independent LinkedIn accounts across the team. In practice the
--   studio uses ONE shared Unipile workspace, so per-user credentials were a
--   footgun — a new hire would open the tool, see empty inputs, and have no
--   way to know where to get the values. Follows the same treatment applied
--   to openai_api_key in migration 20260525_0003_li_outreach_drop_byok_keys.sql.
--
-- This migration:
--   1. Wipes per-user unipile_dsn / unipile_api_key values — outreach now reads
--      from env vars UNIPILE_DSN / UNIPILE_API_KEY.
--   2. Wipes per-user proxy_url — outreach now reads from env var LI_PROXY_URL.
--   Columns are left in place (non-destructive) so no code that still selects
--   the row breaks; a follow-up destructive migration can DROP them once we've
--   confirmed nothing else reads them. All three are NOT NULL text columns
--   defaulting to '' (see migrations 20260320_0001 and 20260320_0002), so we
--   clear to '' rather than NULL — same falsy semantics in JS, no constraint
--   surgery required inside a pure data migration.
--
-- Companion code changes in this PR:
--   - campaignRunner.ts + scraperLogic.ts + webhook/route.ts +
--     accounts/sync/route.ts + accounts/[id]/route.ts: read
--     process.env.UNIPILE_DSN / UNIPILE_API_KEY instead of settings.
--   - settings/route.ts PUT: unipile_dsn, unipile_api_key, proxy_url removed
--     from `allowed` list — incoming values are silently dropped.
--   - li-outreach/page.tsx + li-outreach-v2/page.tsx: shared inputs removed
--     from the settings form, replaced by a static "managed centrally" note.

BEGIN;

UPDATE li_settings
   SET unipile_dsn = '',
       unipile_api_key = '',
       proxy_url = '',
       updated_at = NOW()
 WHERE unipile_dsn <> '' OR unipile_api_key <> '' OR proxy_url <> '';

COMMIT;
