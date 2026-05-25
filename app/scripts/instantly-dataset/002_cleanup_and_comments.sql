-- ============================================================================
-- 002: cleanup + lookup tables + column comments
-- Run on instantly_dataset DB. Idempotent.
--
-- What this does:
--   1. Drops unused stuff: raw_webhooks (operational only), raw_emails.is_unread / is_focused (UI flags)
--   2. Creates lookup_* tables for Instantly's magic-number fields (status codes, ue_type etc.)
--      so AI can JOIN and get human labels instead of guessing what `status=2` means
--   3. Adds COMMENT ON TABLE / COMMENT ON COLUMN to every important field so an AI agent
--      reading information_schema.columns instantly understands what each column carries
-- ============================================================================

-- ─── 1. cleanup ─────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS raw_webhooks CASCADE;

ALTER TABLE raw_emails DROP COLUMN IF EXISTS is_unread;
ALTER TABLE raw_emails DROP COLUMN IF EXISTS is_focused;

-- ─── 2. lookup tables ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lookup_ue_types (
  value        INT PRIMARY KEY,
  label        TEXT NOT NULL,
  label_ru     TEXT NOT NULL,
  description  TEXT NOT NULL
);
COMMENT ON TABLE lookup_ue_types IS
  'Decoding for raw_emails.ue_type. Source: app/src/lib/instantly/emailsExport.ts';
INSERT INTO lookup_ue_types(value, label, label_ru, description) VALUES
  (1, 'sent',       'Отправлено',         'Outbound email sent by one of our campaigns'),
  (2, 'lead_reply', 'Ответ лида',         'Reply received from a lead'),
  (3, 'our_reply',  'Наш ответ',          'Manual reply we sent back to a lead from the inbox'),
  (4, 'unknown_4',  'Неизвестно (тип 4)', 'Undocumented Instantly type. Observed: outbound Re: messages from our mailbox. Likely auto-follow-up or AI-generated. Rare. TODO: verify with Instantly.')
ON CONFLICT (value) DO UPDATE SET
  label = EXCLUDED.label, label_ru = EXCLUDED.label_ru, description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS lookup_interest_status (
  value        INT PRIMARY KEY,
  label        TEXT NOT NULL,
  label_ru     TEXT NOT NULL,
  description  TEXT NOT NULL
);
COMMENT ON TABLE lookup_interest_status IS
  'Decoding for raw_leads.interest_status and raw_emails.i_status.';
INSERT INTO lookup_interest_status(value, label, label_ru, description) VALUES
  ( 0, 'unprocessed',     'Не обработан',        'No interest classification yet'),
  ( 1, 'interested',      'Заинтересован',       'Lead expressed interest'),
  (-1, 'not_interested',  'Не заинтересован',    'Lead explicitly declined'),
  (-2, 'reply_received',  'Ответ получен',       'Lead replied but classification deferred'),
  (-3, 'invalid_contact', 'Неверный контакт',    'Wrong person / contact unreachable')
ON CONFLICT (value) DO UPDATE SET
  label = EXCLUDED.label, label_ru = EXCLUDED.label_ru, description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS lookup_campaign_status (
  value        INT PRIMARY KEY,
  label        TEXT NOT NULL,
  label_ru     TEXT NOT NULL,
  description  TEXT NOT NULL
);
COMMENT ON TABLE lookup_campaign_status IS
  'Decoding for raw_campaigns.status. Source: app/src/lib/instantly/types.ts CampaignStatus enum.';
INSERT INTO lookup_campaign_status(value, label, label_ru, description) VALUES
  (  0, 'draft',                  'Черновик',                 'Campaign created but never activated'),
  (  1, 'active',                 'Активна',                  'Campaign actively sending'),
  (  2, 'paused',                 'На паузе',                 'Manually paused, no sending'),
  (  3, 'completed',              'Завершена',                'All leads contacted, finished'),
  (  4, 'running_subsequences',   'Подпоследовательности',    'Main sequence done, follow-ups running'),
  ( -1, 'accounts_unhealthy',     'Аккаунты нездоровы',       'Halted: associated mailboxes have issues'),
  ( -2, 'bounce_protect',         'Защита от bounce',         'Auto-paused due to high bounce rate'),
  (-99, 'account_suspended',      'Аккаунт заблокирован',     'Workspace-level account suspension')
ON CONFLICT (value) DO UPDATE SET
  label = EXCLUDED.label, label_ru = EXCLUDED.label_ru, description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS lookup_account_status (
  value        INT PRIMARY KEY,
  label        TEXT NOT NULL,
  label_ru     TEXT NOT NULL,
  description  TEXT NOT NULL
);
COMMENT ON TABLE lookup_account_status IS
  'Decoding for raw_accounts.status. Source: app/src/lib/instantly/types.ts AccountStatus enum.';
INSERT INTO lookup_account_status(value, label, label_ru, description) VALUES
  ( 1, 'active',           'Активен',             'Mailbox actively sending'),
  ( 2, 'paused',           'На паузе',            'Mailbox paused, will not send'),
  ( 3, 'maintenance',      'Обслуживание',        'Temporarily out of rotation for maintenance'),
  (-1, 'connection_error', 'Ошибка подключения',  'IMAP/SMTP authentication or connection broken'),
  (-2, 'soft_bounce_error','Soft bounce',         'Soft bounces above threshold; auto-paused'),
  (-3, 'sending_error',    'Ошибка отправки',     'Generic sending failure')
ON CONFLICT (value) DO UPDATE SET
  label = EXCLUDED.label, label_ru = EXCLUDED.label_ru, description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS lookup_warmup_status (
  value        INT PRIMARY KEY,
  label        TEXT NOT NULL,
  label_ru     TEXT NOT NULL,
  description  TEXT NOT NULL
);
COMMENT ON TABLE lookup_warmup_status IS
  'Decoding for raw_accounts.warmup_status. Source: app/src/lib/instantly/types.ts WarmupStatus enum.';
INSERT INTO lookup_warmup_status(value, label, label_ru, description) VALUES
  ( 0, 'paused',                'Пауза',                 'Warmup currently paused'),
  ( 1, 'active',                'Активен',               'Warmup running normally'),
  (-1, 'banned',                'Бан',                   'Account banned by provider'),
  (-2, 'spam_folder_unknown',   'Спам-папка',            'Warmup emails landing in spam'),
  (-3, 'permanent_suspension',  'Постоянная блокировка', 'Permanently suspended, unrecoverable')
ON CONFLICT (value) DO UPDATE SET
  label = EXCLUDED.label, label_ru = EXCLUDED.label_ru, description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS lookup_provider_code (
  value        INT PRIMARY KEY,
  label        TEXT NOT NULL,
  description  TEXT NOT NULL
);
COMMENT ON TABLE lookup_provider_code IS
  'Decoding for raw_accounts.provider_code. Source: app/src/lib/instantly/types.ts ProviderCode enum.';
INSERT INTO lookup_provider_code(value, label, description) VALUES
  (1, 'Custom IMAP/SMTP', 'Self-hosted or arbitrary mailbox via raw IMAP/SMTP'),
  (2, 'Google',           'Google Workspace mailbox via OAuth'),
  (3, 'Microsoft',        'Microsoft 365 / Outlook via OAuth'),
  (4, 'AWS',              'Amazon SES integration'),
  (8, 'AirMail',          'AirMail provider integration')
ON CONFLICT (value) DO UPDATE SET
  label = EXCLUDED.label, description = EXCLUDED.description;

-- ─── 3. table comments ─────────────────────────────────────────────────────

COMMENT ON TABLE raw_campaigns IS
  'Outbound email campaigns from Instantly. status decoded via lookup_campaign_status.
   Sequences (steps + A/B variants) are exploded into raw_campaign_steps for join-ability.';
COMMENT ON TABLE raw_campaign_steps IS
  'Exploded campaign sequences: one row per (campaign × sequence × step × variant).
   Join with raw_campaign_step_analytics_snap on (campaign_id, step_n, variant_n) to get
   subject × open/reply metrics. body_text is HTML-stripped from sequences[].steps[].variants[].body.';
COMMENT ON TABLE raw_accounts IS
  'Sender mailboxes connected to Instantly. status via lookup_account_status,
   warmup_status via lookup_warmup_status, provider_code via lookup_provider_code.
   Email is the natural key (one Instantly mailbox = one email address).';
COMMENT ON TABLE raw_leads IS
  'Recipients across all campaigns. interest_status via lookup_interest_status.
   Lead may appear in multiple campaigns; primary key is Instantly''s lead id.
   custom_variables is the JSONB blob of {{variableName}} placeholders used in templates.';
COMMENT ON TABLE raw_emails IS
  'Per-message log: every outbound send, every lead reply, every manual response.
   ue_type via lookup_ue_types (1=sent, 2=lead_reply, 3=our_reply).
   Group by thread_id to reconstruct conversations.
   body_text is HTML-stripped (original HTML lives in raw_payload.body if needed).';
COMMENT ON TABLE raw_lead_lists IS
  'Named lead lists in Instantly. Leads can be associated via raw_leads.lead_list_id.';
COMMENT ON TABLE raw_email_templates IS
  'Reusable email templates saved in the workspace. body is HTML-stripped to plain text.';
COMMENT ON TABLE raw_custom_tags IS
  'Workspace tags. Used for cross-cutting labeling of campaigns/accounts/leads.';
COMMENT ON TABLE raw_custom_tag_mappings IS
  'M:N: which tag is applied to which resource. Filter by resource_type (campaign|account|lead).';
COMMENT ON TABLE raw_lead_labels IS
  'Labels assignable to leads (colored badges). Less used than tags.';
COMMENT ON TABLE raw_block_list IS
  'Emails/domains to never contact. type can be ''email'' or ''domain''.';
COMMENT ON TABLE raw_subsequences IS
  'Follow-up sequences attached to a parent campaign. Run after the main sequence finishes.';
COMMENT ON TABLE raw_campaign_analytics_overview_snap IS
  'Per-campaign aggregate snapshot. Each (snapshot_id, campaign_id) is one daily/weekly point.
   Aggregates over the campaign''s entire lifetime up to that snapshot moment.';
COMMENT ON TABLE raw_campaign_analytics_daily_snap IS
  'Per-campaign × per-day metrics snapshot. (snapshot_id, campaign_id, date) is unique.
   Use for trend lines: opens/replies/clicks over time.';
COMMENT ON TABLE raw_campaign_step_analytics_snap IS
  'Per-step × per-variant aggregate snapshot. Join with raw_campaign_steps on
   (campaign_id, step_n, variant_n) to get subject × performance.';
COMMENT ON TABLE raw_warmup_analytics_snap IS
  'Per-mailbox × per-day warmup health. sent/received/landed_inbox/landed_spam by date.';
COMMENT ON TABLE dataset_snapshots IS
  'One row per pull/sync run. mode: full (initial dump), delta (daily sync),
   analytics-only (overview refresh). All *_snap tables FK to this for time travel.';

-- ─── 4. critical column comments ───────────────────────────────────────────

-- raw_emails (the heavy hitter)
COMMENT ON COLUMN raw_emails.id              IS 'Instantly''s email id (uuid string)';
COMMENT ON COLUMN raw_emails.campaign_id     IS 'FK → raw_campaigns.id';
COMMENT ON COLUMN raw_emails.lead_id         IS 'FK → raw_leads.id (the recipient)';
COMMENT ON COLUMN raw_emails.thread_id       IS 'Conversation identifier. Group rows by this to reconstruct full email thread.';
COMMENT ON COLUMN raw_emails.eaccount        IS 'Sender mailbox (FK → raw_accounts.email). For ue_type=2 (lead replies) this is the OUR mailbox that received the reply.';
COMMENT ON COLUMN raw_emails.ue_type         IS '1=sent, 2=lead_reply, 3=our_reply. JOIN lookup_ue_types ON value = ue_type for labels.';
COMMENT ON COLUMN raw_emails.subject         IS 'Subject line. May still contain unresolved {{variableName}} template placeholders for ue_type=1.';
COMMENT ON COLUMN raw_emails.body_text       IS 'HTML-stripped plain text. Original HTML is preserved inside raw_payload.body.';
COMMENT ON COLUMN raw_emails.content_preview IS 'Instantly''s own short preview snippet (~200 chars), usually first line of body.';
COMMENT ON COLUMN raw_emails.from_email      IS 'Address that appeared in From: header. For ue_type=1 = our eaccount; for ue_type=2 = the lead''s address.';
COMMENT ON COLUMN raw_emails.to_email        IS 'Address that appeared in To: header. Comma-separated if multiple recipients.';
COMMENT ON COLUMN raw_emails.i_status        IS 'Snapshot of lead''s interest_status at the time of this email. Same lookup as raw_leads.interest_status.';
COMMENT ON COLUMN raw_emails.ai_interest_value IS 'Instantly''s own AI-guessed interest score for this email (separate from our qualification). Higher = more interested.';
COMMENT ON COLUMN raw_emails.timestamp_email   IS 'When the email was actually sent/received (mailbox timestamp). Prefer this over timestamp_created for time-series.';
COMMENT ON COLUMN raw_emails.timestamp_created IS 'When Instantly''s DB recorded this email. Usually within seconds of timestamp_email for inbound; for outbound = scheduling moment.';
COMMENT ON COLUMN raw_emails.raw_payload IS 'Full original Instantly /emails item, JSON. Use as escape hatch if a needed field isn''t broken out into a column.';

-- raw_leads
COMMENT ON COLUMN raw_leads.interest_status IS 'Lookup: lookup_interest_status. Set by Instantly''s AI or manual action.';
COMMENT ON COLUMN raw_leads.campaign_id     IS 'FK → raw_campaigns.id. Same lead in multiple campaigns = multiple rows.';
COMMENT ON COLUMN raw_leads.lead_list_id    IS 'FK → raw_lead_lists.id (if lead was added via a list).';
COMMENT ON COLUMN raw_leads.custom_variables IS 'JSONB of {{var}} placeholders supplied when adding the lead. e.g. {"companyName": "Acme", "firstName": "John"}.';

-- raw_campaigns
COMMENT ON COLUMN raw_campaigns.status              IS 'Lookup: lookup_campaign_status.';
COMMENT ON COLUMN raw_campaigns.campaign_schedule   IS 'JSONB of schedule.schedules[].timing/.days/.timezone. start_date/end_date may be there too.';
COMMENT ON COLUMN raw_campaigns.sequences           IS 'JSONB. sequences[N].steps[M].variants[K] with subject + body. Already exploded into raw_campaign_steps.';
COMMENT ON COLUMN raw_campaigns.email_list          IS 'Array of sender mailbox addresses (FK → raw_accounts.email) that this campaign uses for sending.';
COMMENT ON COLUMN raw_campaigns.daily_limit         IS 'Max emails per day across all senders. NULL = use Instantly default.';
COMMENT ON COLUMN raw_campaigns.daily_max_leads     IS 'Max new leads contacted per day.';
COMMENT ON COLUMN raw_campaigns.email_gap           IS 'Minutes between consecutive sends from same sender (random within ±random_wait_max).';
COMMENT ON COLUMN raw_campaigns.stop_on_reply       IS 'If true, sequence halts for this lead the moment they reply.';
COMMENT ON COLUMN raw_campaigns.is_evergreen        IS 'If true, campaign restarts the sequence when leads cycle through.';

-- raw_campaign_steps
COMMENT ON COLUMN raw_campaign_steps.sequence_n IS 'Top-level sequence index. Most campaigns have only sequence 0; subsequences make this >0.';
COMMENT ON COLUMN raw_campaign_steps.step_n     IS 'Step index within sequence (0-based). Step 0 = first email, step 1 = follow-up, etc.';
COMMENT ON COLUMN raw_campaign_steps.variant_n  IS 'A/B variant index (0-based). 0 = main, 1+ = alternatives. Instantly distributes sends across variants.';
COMMENT ON COLUMN raw_campaign_steps.subject    IS 'Subject line as templated. Contains {{placeholders}} resolved per-lead at send time.';
COMMENT ON COLUMN raw_campaign_steps.body_text  IS 'HTML-stripped body. Same placeholders.';
COMMENT ON COLUMN raw_campaign_steps.wait_days  IS 'Days to wait after previous step before sending this one.';

-- raw_accounts
COMMENT ON COLUMN raw_accounts.email             IS 'Mailbox address. Natural primary key.';
COMMENT ON COLUMN raw_accounts.status            IS 'Lookup: lookup_account_status.';
COMMENT ON COLUMN raw_accounts.warmup_status     IS 'Lookup: lookup_warmup_status.';
COMMENT ON COLUMN raw_accounts.provider_code     IS 'Lookup: lookup_provider_code.';
COMMENT ON COLUMN raw_accounts.daily_limit       IS 'Per-mailbox daily send cap.';
COMMENT ON COLUMN raw_accounts.sending_gap       IS 'Minutes between sends from this mailbox (overrides campaign-level email_gap).';
COMMENT ON COLUMN raw_accounts.stat_warmup_score IS 'Instantly''s warmup quality score, typically 0-100.';

-- dataset_snapshots
COMMENT ON COLUMN dataset_snapshots.mode    IS 'full = first-time dump; delta = daily nightly cron; analytics-only = refreshed only the snap tables';
COMMENT ON COLUMN dataset_snapshots.ok      IS 'true if the run completed without fatal errors; false if crashed mid-run (audit row remains for debugging)';
COMMENT ON COLUMN dataset_snapshots.counts  IS 'JSONB of per-entity row counts ingested in this run, e.g. {"new_emails": 4521, "active_campaigns": 47}';
COMMENT ON COLUMN dataset_snapshots.started_at  IS 'When this run was initiated.';
COMMENT ON COLUMN dataset_snapshots.finished_at IS 'When this run completed (NULL if still running or crashed without cleanup).';

-- raw_warmup_analytics_snap
COMMENT ON COLUMN raw_warmup_analytics_snap.landed_inbox IS 'Warmup test emails that landed in inbox (not spam). Higher = better deliverability.';
COMMENT ON COLUMN raw_warmup_analytics_snap.landed_spam  IS 'Warmup test emails that landed in spam. Want this near zero.';
COMMENT ON COLUMN raw_warmup_analytics_snap.received     IS 'Warmup emails this mailbox received from other warmup peers (inbound activity).';
COMMENT ON COLUMN raw_warmup_analytics_snap.sent         IS 'Warmup emails this mailbox sent to other peers.';
