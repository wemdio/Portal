# Insights Log

Append-only chronology. Newest first.

Format: `YYYY-MM-DD: <one-line summary>. Details: [link to page or analysis]`

---

## 2026-05-30

- **Adversarial workflow (22 агента, 1.8M токенов): 3 из 4 глубоких гипотез УБИТЫ скепсисом, 1 выжила.** query_log id=18-21. ✅ ВЫЖИЛА (conf 78, прошла все атаки): **глубина последовательности** — follow-up ответы конвертят в лид ~2× лучше первого касания (within-campaign 4.59% vs 10.66%, z=6.35, paired p=0.0022); шаги 2-3 несут ~47% лидов. НЕ резать последовательности. ❌ УБИТЫ (все три — конфаунд **возраста кампании**): «reply-only = мусорные ответы» (позитив-доля идентична 47.6 vs 46.5%, p=0.28); «mailbox health = рычаг на лиды» (60× градиент = age+coverage конфаунд); «малые списки бьют большие» (артефакт раздутого `contacted_count` + возраста; корреляция меняет знак). Все выводы → [playbook.md](./playbook.md). Операционный claim агента про «краш квалификатора на 412» опровергнут живыми логами (0 ошибок, здоров).
- **Дневная аналитика: purge + замена (migration 009).** `raw_campaign_analytics_daily_snap` обнулена (1.94M workspace-мусора), создан `v_campaign_daily` из `raw_emails` (корректный per-campaign дневной ряд sends/replies, без API). Баг затрагивал ТОЛЬКО эту таблицу с самого первого пула; остальной датасет корректен; ни один прошлый вывод на ней не строился.
- **`raw_campaign_analytics_daily_snap` сломана: workspace-wide ряд под каждым `campaign_id`.** Все 1881 кампаний имеют идентичный `sum(sent)=7 381 152` и byte-identical 965-дневный ряд — включая кампании с lifetime `contacted_count`=1..5. `raw_payload` содержит те же числа → не наш парсинг, API вернул workspace-данные. Это и есть «1.8M daily metrics» из 2026-05-23 (1881×965 ≈ 1.8M — один ряд, размноженный по кампаниям). **Корень:** `/campaigns/analytics/daily` фильтруется по `campaign_id`, а наш код шлёт UUID под ключом `id` (endpoint его игнорирует → отдаёт все кампании). Баг в 3 местах: [`client.ts:175`](../app/src/lib/instantly/client.ts), [`sync.mjs:436`](../app/scripts/instantly-dataset/sync.mjs), [`pull.mjs:409`](../app/scripts/instantly-dataset/pull.mjs); `syncStepAnalytics` рядом шлёт `campaign_id` правильно. Overview — корректна, ей верим. Дневной ряд кампании строй из `raw_emails`. Поправил COMMENT на таблице (migration 008) + caveat в [dataset-schema.md](./concepts/dataset-schema.md#️-raw_campaign_analytics_daily_snap-сломана-workspace-wide-ряд-под-каждым-campaign_id-2026-05-30). Фикс кода + ре-pull дневной аналитики — TODO (баг продолжается каждую ночь, sync.mjs nightly).

## 2026-05-29

- **Agent ran 3 clients (query_log id=3,4,5), then SELF-CORRECTED id=3.** Initially claimed inMyRoom succeeds because of its subject line — user challenged it. Verification (within-campaign A/B) refuted: same subject 2.74% on one list, 0.00% on another; all 36 leads came from the real-estate-agency segment, not any subject. Real driver = segment/ICP. Lesson written to [subjects/winning-patterns.md](./subjects/winning-patterns.md): subject affects only reply (inconsistently, list-dependent), never attributable to leads. ЮРКОМ («0 лидов» не баг — 171/175 not_lead, аудит-коммодити, bounce 7%) and НАФИ (winning «Исследовательский чекап» 7.45% on SMB diluted by wrong-ICP developer campaign) hold up.
- **Dropped "System A" (migration 006).** Briefly built a deterministic SQL health-calculator (`health-check.mjs` + dim tables + snapshot storage) — wrong approach, removed it. The eval loop is AI-agent-in-the-loop: the agent answers client questions on demand and logs to `query_log`; weekly we review + improve. Client→campaign map queried LIVE (no rot). KEPT the genuine wins: `v_subject_performance` fix + `v_campaign_mailboxes` (migration 005), and `sync.mjs` now refreshes step+daily analytics. See [client-health-questions.md](./concepts/client-health-questions.md).
- **Eval loop first real iteration (query_log id=2, ДПО ПРОФ).** Acting as the agent surfaced 2 dataset bugs (subjects NULL for all campaigns; mailbox health blind to tag-based senders), both fixed same session. Diagnosis that a calculator couldn't reach: ДПО's low reply is the client's base quality, not our delivery (64 mailboxes healthy, reply uniformly low across all subjects).

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
