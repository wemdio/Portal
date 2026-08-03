# Funded companies catalog (Crunchbase-style) — ingest pipeline

Powers the **«Crunchbase · Стартапы и раунды»** parser tab. A single source-agnostic
table `public.funded_companies` (see `supabase/migrations/20260609_0004_*` and `_0005_*`)
holds companies + funding from several free, legally-clean sources. The UI/API never
change when you add a source — only an ingest script does.

## Why these sources (and why not Crunchbase itself)

Real Crunchbase data is **not** legally free: the official funding API is Enterprise-only
(sales-gated, no free tier since ~2025), bulk CSV is Enterprise, and scraping crunchbase.com
violates its ToS + is bot-protected (PerimeterX). So we blend free, redistributable sources
that deliver the must-haves (name / website / description) + funding:

| source tag   | source                         | gives                                              | license            |
|--------------|--------------------------------|----------------------------------------------------|--------------------|
| `yc`         | Y Combinator (yc-oss/api)      | name, website, long description, batch, stage, tags | public YC data     |
| `sec_formd`  | SEC EDGAR Form D (DERA)        | US private **funding rounds** (amount, date, type) | US public domain   |
| `pdl`        | People Data Labs (existing)    | enrichment join: website/industry for SEC issuers  | CC BY 4.0          |

Funding freshness is **US-only** (SEC). For global funding breadth you need a paid source
— drop it in as a new `source` tag (see "Adding sources" below) with zero UI/API changes.

## Run order

```bash
# 0) one-time: apply the migrations (create table + RPCs)
#    (done via the repo's normal migration runner)

# 1) YC — fast, rich descriptions (~6k companies). Idempotent (upsert by id).
node --env-file ../.env scripts/funded/ingest-yc.mjs

# 2) SEC Form D — US funding rounds. SEC_USER_AGENT is MANDATORY (403 without it).
SEC_USER_AGENT="Studio Portal contact@yourstudio.com" \
  node --env-file ../.env scripts/funded/ingest-sec-formd.mjs --quarters 2025q4,2026q1
#   • add more quarters for deeper history (datasets exist 2008Q1–present)
#   • pass --include-funds to keep pooled investment funds (excluded by default)
#   • or point at an already-extracted folder: --dir ./tmp/2025Q4_d

# 3) OPTIONAL: enrich SEC rows with website/industry from PDL (normalized-name match)
psql "$DATABASE_URL" -f scripts/funded/enrich-sec-from-pdl.sql
```

## Cadence

- **YC**: weekly cron — `all.json` is regenerated daily upstream, so a weekly
  re-run is enough; re-running upserts.

  **Prod cron (suggested — NOT installed on prod yet, YC rows are only refreshed on manual runs):**
  ```
  40 5 * * 1 docker exec portal node /app/scripts/funded/ingest-yc.mjs >> /var/log/funded-yc-ingest.log 2>&1
  ```
- **SEC Form D, bulk**: quarterly (new DERA zip posted shortly after quarter-end).
  **Re-run with the FULL window** (e.g. `--quarters 2024q1,...,<new quarter>`) — the
  bulk upsert recomputes each issuer's totals from the quarters it sees, so a
  partial window would understate totals. The full re-run also corrects any drift
  accumulated by the daily poller.
- **SEC Form D, daily poller** (`poll-sec-daily.mjs`): closes the quarterly lag.
  Polls EDGAR full-text search for new Form D filings (companies must file within
  15 days of first sale), fetches each filing's `primary_doc.xml`, upserts with
  newer-wins/additive merge semantics. Idempotent via the `funded_sec_daily_log`
  table (migration `20260611_0001`) — overlapping windows never double-count.
  Default window: last 10 days (self-healing if a run is missed).

  **Prod cron (installed on 139):**
  ```
  40 6 * * * docker exec -e SEC_USER_AGENT="..." portal node /app/scripts/funded/poll-sec-daily.mjs >> /var/log/funded-sec-poll.log 2>&1
  ```
  The script ships inside the portal image (`/app/scripts/funded/`); the container
  already has `DATABASE_URL`. SEC requires a descriptive User-Agent with a contact
  email on EVERY request — without it (or with one its WAF dislikes) you get 403.
- **PDL enrichment** (`enrich-sec-from-pdl.sql`): re-run after every large SEC
  ingest (a bulk quarterly run or a big daily-poller catch-up) — new SEC rows
  arrive without website/industry. Matching is by NORMALIZED name (lowercase,
  punctuation and legal/generic suffixes stripped: SEC legal entities ↔ PDL
  brand names) with false-positive guards (normalized name ≥ 5 chars and
  contains a letter). Measured on a 2000-row sample (2026-08-02): ~28% of
  websiteless SEC rows get a website, vs ~4% with the old exact-name match.
  One pass over `pdl_companies` (~13M rows with website) takes a few minutes;
  the script is idempotent (touches only `website IS NULL` rows), so re-runs
  process just the delta.

## Attribution

Export footers carry per-source attribution (see `app/src/lib/funded/labels.ts`):
YC (Y Combinator public data), SEC (U.S. SEC EDGAR — public domain), PDL (CC BY 4.0).
SEC + Wikidata are clean for client redistribution; YC is public YC data; PDL needs the
CC BY credit line (already wired).

## Adding sources later (no UI/API changes)

Write one ingest script that upserts into `funded_companies` with a new `source` tag:

- **Wikidata** (`source='wikidata'`, **CC0 — cleanest for client redistribution**): ~108K+
  global companies with name + official website (P856) + short description + industry (P452)
  + inception (P571). No funding (SEC stays the funding layer). Pull via SPARQL paginated by
  country, or the weekly JSON dump. Best free way to maximize global name/desc/website volume.
- **Bright Data Crunchbase dataset** (`source='brightdata'`, paid ~$2.50/1k): the full
  Crunchbase-scale company + funding + investors set. Download the bulk file once and upsert.
  This is the upgrade path to true Crunchbase breadth/funding globally.

Map each source's fields onto the `funded_companies` columns; leave unknown columns NULL.
Keep `id = '<source>:<natural_key>'` so re-runs are idempotent.
