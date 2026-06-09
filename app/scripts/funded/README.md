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

# 3) OPTIONAL: enrich SEC rows with website/industry from PDL (exact-name match)
psql "$DATABASE_URL" -f scripts/funded/enrich-sec-from-pdl.sql
```

## Cadence

- **YC**: daily/weekly cron — `all.json` is regenerated daily; re-running upserts.
- **SEC Form D**: quarterly (new DERA zip posted shortly after quarter-end). For
  near-realtime new filings, the EDGAR full-text API (`efts.sec.gov/LATEST/search-index?forms=D`)
  can be polled daily — not implemented here (quarterly bulk is enough to start).

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
