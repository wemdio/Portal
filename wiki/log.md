# Insights Log

Append-only chronology. Newest first.

Format: `YYYY-MM-DD: <one-line summary>. Details: [link to page or analysis]`

---

## 2026-05-26

- **Self-improving eval loop (migration 003).** Added `query_log` table + two views (`v_query_log_review_queue`, `v_query_log_repeats`) + concept page [eval-loop.md](./concepts/eval-loop.md) + weekly review template. Inspired by [YC talk on self-improving companies](https://www.youtube.com/watch?v=X_JsIHUfUjc) (Tom Blomfield, 4:12 — monitoring agent watching every query, identifying failures, auto-fixing overnight). Our v1 is human-in-loop weekly review; promote to autonomous when patterns stabilize. Mandatory logging now in `CLAUDE.md`.
- **Wiki initialized.** Three-layer architecture in place: SQL truth-layer → wiki summarization layer → user. AI agent now reads `CLAUDE.md` first every session. Detail: [README.md](./README.md).
- **Schema cleanup completed (migration 002).** Dropped `raw_webhooks` (operational), `raw_emails.is_unread/is_focused/body_html` (UI flags, never meaningfully populated). Added 6 `lookup_*` tables decoding Instantly's magic numbers + 74 `COMMENT ON` (23 table + 51 column) so AI introspection works. Detail: [concepts/dataset-schema.md](./concepts/dataset-schema.md).
- **Found undocumented `ue_type=4`.** Only 2 rows in 1.7M. Outbound "Re:" from our mailboxes, likely auto-follow-up. Added to `lookup_ue_types` with TODO to verify with Instantly. Source: query `SELECT count(*), array_agg(DISTINCT subject) FILTER (WHERE ue_type = 4) FROM raw_emails`.

## 2026-05-23..25

- **Initial full dataset pull.** Snapshot `98974f54-5723-4555-9ca9-20499b79cd2c`. 1,881 campaigns / 167,735 leads / 1,715,907 emails / 1.8M daily metrics. Total DB size ~7.4 GB (now 9 GB after lookups + indices).
- **Discovered Instantly /emails rate limit ~10-15 RPM sustained** (regardless of API key — workspace-wide). 20+ RPM triggers throttling with sliding penalty. Detail: [pull-campaign-analytics.mjs](../app/scripts/pull-campaign-analytics.mjs) header comment.
- **Worker interference incident.** Running pull at 30+ RPM degraded `portal-worker-instantly-leads` poll cycle from 30s to 20+ min between 14:12-15:25 UTC on 22 May. ~2-4 missed lead qualifications. Lesson: any /emails pulling shares budget with the qualifier worker. Mitigation: `docker stop portal-worker-instantly-leads` during heavy pulls, restore after.
- **Per-V8-string-limit crash.** `JSON.stringify` of `emails-by-campaign.json` at 646 MB exceeded V8's ~512 MB string limit. Migrated cache to per-campaign files (`emails/<id>.json`) in `pull.mjs`. Won't recur. Detail: [migrate-cache-to-per-campaign-files.mjs](../app/scripts/instantly-dataset/migrate-cache-to-per-campaign-files.mjs).

## Earlier

- **AI lead qualification pipeline runs on prod** (`portal-worker-instantly-leads` container, polls every 30s, /emails ue_type=2, dedupes against `instantly_lead_qualifications`, classifies via OpenRouter, sends Telegram alert only for `status='lead'`). Self-hosted Supabase backing (NOT the cloud project in `.env` — that's stale). See [leadQualificationWorker.ts](../app/src/lib/instantly/leadQualificationWorker.ts).
