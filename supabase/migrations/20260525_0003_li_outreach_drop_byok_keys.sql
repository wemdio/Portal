-- Data-only cleanup: deprecate BYOK (per-user OpenAI key + model) in li_settings.
--
-- Background:
--   When LI outreach was first integrated in March 2026, every user could store
--   their own OpenAI key + model in `li_settings.openai_api_key` /
--   `li_settings.openai_model`. The campaign runner and the auto-reply webhook
--   both preferred those values over the env fallback.
--
--   In May 2026 we switched the central provider to Requesty
--   (https://router.requesty.ai/v1/chat/completions) accessed via a shared env
--   key `OPENROUTER_LI_OUTREACH_API_KEY`. The Settings UI stopped exposing the
--   per-user openai_api_key/model inputs months ago, but:
--
--     - the corresponding DB columns still existed,
--     - the API endpoint `PUT /api/tools/li-outreach/settings` still accepted
--       them in the `allowed` list,
--     - the runner code still read them with priority over the env key.
--
--   Result: one production user (66873c8c-…) had a leftover OpenAI-native
--   `sk-proj-…` key in DB which, against the Requesty endpoint, returned 401
--   silently — their AI personalization stopped working entirely. Other rows
--   had bare model names like `gpt-4o-mini` (no provider prefix); Requesty
--   rejects those with 400 `Invalid model, expected: "provider/model"`.
--
-- This migration:
--   1. Wipes per-user openai_api_key values — outreach now uses the central
--      env Requesty key for everyone. The column itself is left in place
--      (non-destructive); a follow-up destructive migration can DROP it once
--      we've confirmed no out-of-tree service still reads it.
--   2. Normalizes lingering bare model names in li_settings.openai_model and
--      li_campaigns.ai_model to the `provider/model` shape Requesty requires.
--      Defaults the provider to `openai/` because that was the historical
--      default for these campaigns. Operators can later switch to other
--      providers explicitly by writing e.g. `anthropic/claude-3-5-sonnet`.
--
-- Companion code changes in this PR (so future writes can't recreate the
-- leftover state):
--   - settings/route.ts: `openai_api_key` / `openai_model` removed from the
--     PUT `allowed` list — incoming values are now silently dropped.
--   - page.tsx: those fields removed from `LiSettings` UI type + form state
--     so the UI never sends them again.
--   - campaignRunner.ts + webhook/route.ts: stopped reading
--     `settings.openai_api_key` / `settings.openai_model`. AI key comes from
--     env, model from `li_campaigns.ai_model` (or built-in default).
--   - aiService.ts: new normalizeModel() that prefixes `openai/` when the
--     name is bare, so even if a stale row sneaks in we don't 400.

BEGIN;

-- 1. Wipe leftover BYOK keys.
UPDATE li_settings
   SET openai_api_key = NULL,
       updated_at     = NOW()
 WHERE openai_api_key IS NOT NULL
   AND openai_api_key <> '';

-- 2. Normalize bare model names in li_settings (legacy per-user override).
UPDATE li_settings
   SET openai_model = 'openai/' || openai_model,
       updated_at   = NOW()
 WHERE openai_model IS NOT NULL
   AND openai_model <> ''
   AND openai_model NOT LIKE '%/%';

-- 3. Normalize bare model names in li_campaigns (per-campaign override). NULL
--    is fine here — the runner falls back to 'openai/gpt-4o-mini'.
UPDATE li_campaigns
   SET ai_model   = 'openai/' || ai_model,
       updated_at = NOW()
 WHERE ai_model IS NOT NULL
   AND ai_model <> ''
   AND ai_model NOT LIKE '%/%';

COMMIT;
