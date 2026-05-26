-- Per-launch override for which mailboxes (from the preset's pool) are
-- used to send THIS specific campaign.
--
-- Why: a client may have one preset with N connected mailboxes but want
-- to run two parallel campaigns on the same lead base — different
-- offers, different sending mailboxes per offer. Without this column,
-- runLaunch always grabs the full `preset.email_account_ids`, so the
-- only way to split was to maintain multiple presets (heavyweight,
-- admin-only) or edit Instantly directly post-launch (lossy on history).
--
-- Semantics:
--   NULL              → use the full preset pool (legacy behavior, default).
--   text[] (non-null) → exact subset of `preset.email_account_ids`
--                       at launch time. Validated on insert; the API
--                       rejects elements not present in the preset.
--
-- Validation lives at the application layer (runLaunch.ts), not as a
-- CHECK constraint, because the source-of-truth pool lives in a
-- different row (presets) and Postgres CHECK can't dereference rows.
--
-- Admin sync impact: when admin edits preset.email_account_ids, the
-- preset→running-campaign sync must NOT push email_list to launches
-- where this column is non-null — those launches have an explicit
-- per-launch choice the admin shouldn't silently overwrite.

alter table public.client_campaign_launches
  add column if not exists email_account_ids text[];

comment on column public.client_campaign_launches.email_account_ids is
  'Per-launch subset of preset.email_account_ids. NULL = use full preset pool. '
  'Non-null = client picked a specific subset for this campaign (e.g. to run two '
  'parallel campaigns on the same base with different mailboxes per offer).';
