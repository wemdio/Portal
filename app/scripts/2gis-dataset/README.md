# 2GIS dataset

This directory owns the isolated `2gis_dataset` schema and snapshot importer.
It must never be pointed at the main Portal database or `instantly_dataset`.
Both the schema and importer verify `current_database()` before their first
persistent write.

## Required database

- Logical database: `2gis_dataset`
- Runtime environment: `TWOGIS_DATASET_DB_URL` with a read/write role limited
  to this database (read access to cards/facets plus export-ticket writes).
- Import environment: `TWOGIS_IMPORT_DATABASE_URL` with the database-owner role.

Database/role creation and grants are infrastructure operations and are
intentionally not performed by these scripts.

## VE2 user (`twogis_ve2`)

The Vertical Engine v2 worker reads this database as its own role, so it can
never take OutreachOS or parser connections (`twogis_runtime` has 12 in total).
`003_ve2_access.sql` creates `twogis_ve2`: read-only, at most 2 connections,
short timeouts, SELECT on `cards`, `card_subcategories`, `dataset_snapshots`
and `facet_subcategories`. Run it as `postgres` in `2gis_dataset`; it is safe
to re-run and sets no password.

- **Password.** Set it only as a SCRAM verifier, in a session with
  `SET log_statement = 'none'`, `SET pgaudit.log = 'none'` and
  `SET pg_stat_statements.track_utility = off`.
  Production logs DDL and tracks utility statements, so a plain
  `ALTER ROLE … PASSWORD` would land in the server log and in
  `pg_stat_statements`. The plain password lives only in the worker's
  `.env.twogis-ve2` (mode 0600, never committed, never printed).
- **pg_hba.** main-postgres needs two lines placed before
  `host all all 127.0.0.1/32 trust`:

  ```
  host  2gis_dataset  twogis_ve2  172.16.0.0/12  scram-sha-256
  host  all           twogis_ve2  all            reject
  ```

  Then run `SELECT pg_reload_conf();` and check `pg_hba_file_rules`. Without
  these lines the role could also log into the main `postgres` database, where
  PUBLIC has CONNECT. The file is `/etc/postgresql/pg_hba.conf` inside the
  container, not on a mount, so recreating main-postgres drops the lines and
  they must be added again. health-check alerts when they are missing.
- **Rollback.** Only after the Ш5 builder rollback («VE2 features» → «Builder
  login» → Rollback). Restore the saved pg_hba copy and reload, then in
  `2gis_dataset` run `DROP OWNED BY twogis_ve2;`, then `DROP ROLE twogis_ve2;`,
  then delete `.env.twogis-ve2`. While `twogis_ve2_builder` exists, remove only
  the two `twogis_ve2` lines instead of restoring the Ш3 copy (it predates the
  builder lines), then reload and check that the `twogis_ve2_builder` lines are
  still in `pg_hba_file_rules`.

## VE2 features (`ve2.card_features`)

`004_ve2_features.sql` is the contract between the step Ш5 builder and the VE2
page reader (`src/lib/verticalEngineV2/twoGisPage.ts`). It is run only in Ш5,
under «да»; nothing runs it now. It has the same database guard as
`001_schema.sql` and one psql variable `step`:

- `install` — the builder role `twogis_ve2_builder` (created `NOLOGIN`, at
  most 2 connections; a re-run never changes LOGIN/NOLOGIN), schemas `ve2`
  (read by `twogis_ve2` through default privileges) and `ve2_build` (staging,
  not readable by VE2), `ve2.build_state`, `ve2.domain_liveness` (with the
  scheme of each live site, `https` or `http`) and `ve2_build.build_meta`.
  Safe to re-run.
- `report` — read only: registrable domains with at least 3 distinct
  subdomains in the snapshot, top `-v report_limit=…` (500 by default).
  Compare it with `VE_TWO_GIS_SITE_BUILDERS`
  (`src/lib/verticalEngineV2/twoGisRows.ts`) before the table is filled.
- `prepare` — one transaction, refused while an import runs: an empty
  `ve2.card_features_new`. Pass `-v new_build=1` only at the start of a build,
  before the builder reads any card: it records the current snapshot in
  `ve2_build.build_meta`. Without it, `prepare` only resets the table of the
  same build, and refuses if there was an import since that build started
  (then start a new build with `-v new_build=1` and a full builder pass).
- `index` — the primary key, the partial covering index over hot cards and
  `VACUUM (ANALYZE)`. Safe to re-run after an interrupted run.
- `swap` — one transaction: no import running; the current snapshot, the
  snapshot the build started on and `-v snapshot_id` are equal; the table is
  not empty and VACUUM has marked its real pages all-visible; any
  INSERT/UPDATE/DELETE after `index` needs `index` again (checked by
  `n_mod_since_analyze`, which the builder's session reports after it commits,
  at the latest when it exits); the table and its index are renamed and
  `ve2.build_state` is written. Every rebuild needs a new snapshot or a higher
  `features_version`; then every running twin's flag is stale.

Liveness follows the rules of the VE2 site reader, otherwise the gate could
not read a hot card. The source of truth is `fetchEvidencePage` in
`src/lib/verticalEngineV2/relevanceEvidence.ts`; the Ш5 builder should reuse a
pure predicate from it if one can be extracted (not done in 3a).
`outcome = 'live'` only when:

- the check starts at `https://host` and falls back to `http://host` only if
  https fails;
- there are at most 3 redirects, each to the same host modulo `www`, on ports
  80/443 only;
- there is no https→http step: such a site is `http` only if `http://host`
  itself passes;
- on every hop, every A record is a public IPv4 address;
- the answer is 2xx with a content type of exactly `text/html`, `text/plain`
  or `application/xhtml+xml`, and a body of at most 1 MB read within 5 s.

`scheme` is the starting scheme that passed. Other redirects are recorded as
`off_domain`, other answers or content as `http_error`.

`card_features` holds one row per candidate card; site-domain dedupe happens at
page time (`DISTINCT ON` the site domain) and in the main-DB line journal
`ve_twogis_rows`. VE2 never reads card phones, e-mails or raw websites.

### Builder login (Ш5 window only)

The builder logs in only during Ш5. Everything below runs as `postgres`,
under «да», in this order:

1. Save a dated Ш5 copy of `pg_hba.conf`: inside main-postgres,
   `cp /etc/postgresql/pg_hba.conf /etc/postgresql/pg_hba.conf.bak-<date>-sh5`,
   then `docker cp` the same copy to the host
   (`/root/pg_hba.conf.bak-<date>-sh5`).
2. While the role is still `NOLOGIN` (the lines are inert), add two lines to
   main-postgres `pg_hba.conf`, before `host all all 127.0.0.1/32 trust`:

   ```
   host  2gis_dataset  twogis_ve2_builder  172.16.0.0/12  scram-sha-256
   host  all           twogis_ve2_builder  all            reject
   ```

   Then run `SELECT pg_reload_conf();` and check `pg_hba_file_rules`. Without
   them the role could also log into the main `postgres` database, where
   PUBLIC has CONNECT and TEMP. health-check alerts while the role can log in
   and its reject line is missing.
3. Only now run `ALTER ROLE twogis_ve2_builder LOGIN;` and set its password
   exactly as for `twogis_ve2` (a SCRAM verifier only, with logging off, see
   «VE2 user»). The plain password lives only in the builder's env file (mode
   0600, for `docker run --env-file`, never committed, never printed).
4. After `swap`: `ALTER ROLE twogis_ve2_builder NOLOGIN;`, end its sessions
   (`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename =
   'twogis_ve2_builder';`) and delete the builder's env file. The builder's
   pg_hba lines may stay: the reject line is protective.

**Rollback**, in this order:

1. `ALTER ROLE twogis_ve2_builder NOLOGIN;`, end its sessions, delete the
   builder's env file.
2. In `2gis_dataset`: `DROP SCHEMA ve2, ve2_build CASCADE;`, then
   `DROP OWNED BY twogis_ve2_builder;`, then `DROP ROLE twogis_ve2_builder;`.
3. Remove only the two `twogis_ve2_builder` lines from `pg_hba.conf`, or
   restore the Ш5 copy from step 1. Never restore the Ш3 backup
   `/root/pg_hba.conf.bak-20261026` and never run `sh3/hba_rollback.sh`: both
   also remove the `twogis_ve2` lines. Then `SELECT pg_reload_conf();` and
   check in `pg_hba_file_rules` that the `twogis_ve2` lines are still there.

## Install the schema

Run only after independently checking the target URL:

```powershell
psql $env:TWOGIS_IMPORT_DATABASE_URL -v ON_ERROR_STOP=1 -f scripts/2gis-dataset/001_schema.sql
```

The SQL file also aborts unless the target database is exactly
`2gis_dataset`.

## Branch counts (number of locations per organization)

The source export has no such field. It ships 14 columns — one card per
physical location, with no organization identifier and no `org` block
(verified against the live database, hotels included). The real number lives in
the 2GIS Places API as `items.org.branch_count` ("численность филиалов"), and a
background job pulls it in.

Install the storage once, after `001_schema.sql`:

```powershell
psql $env:TWOGIS_IMPORT_DATABASE_URL -v ON_ERROR_STOP=1 -f scripts/2gis-dataset/002_branch_count.sql
```

It creates `public.card_branch_counts` (one row per card: `org_id`,
`branch_count`, `status`), the `branch_sync_runs` log and the
`branch_sync_progress` view. The counts deliberately live **outside** `cards`,
which the importer truncates and refills — a column there would throw away
every purchased API request on each new snapshot.

Then run the job (needs `TWOGIS_API_KEY` and `TWOGIS_DATASET_DB_URL`):

```powershell
node scripts/2gis-dataset/sync-branch-counts.mjs --budget=200
node scripts/2gis-dataset/sync-branch-counts.mjs --only-subcategory="Гостиницы"
node scripts/2gis-dataset/sync-branch-counts.mjs --mode=refresh --budget=500
```

Cost model, because it decides everything here: `/3.0/items/byid` takes **up to
100 ids per request**, and the request — not the card — is the billable unit.
The whole 4.28M-card base is therefore ~43 000 requests. The rate ceiling is
600 requests/minute and cannot be raised, so a full pass is bounded at roughly
1.2 hours; the real constraint is the purchased monthly package. A demo key
allows 1 000 requests total (= 100 000 cards), which is enough to validate the
pipeline — all 20 650 hotel cards fit in 207 requests.

`--budget` caps requests per run so a stray restart cannot burn the package.
Runs are resumable: every batch is written immediately and the data itself is
the cursor. Cards that 2GIS no longer knows are stored as `not_found` so the
job never asks for them twice.

The parser checks for the table at runtime, so shipping the app before running
this script only leaves the field empty — it does not break search or export.

## Build and run the importer

The repository already contains `esbuild` and `pg`; no new dependency is
required:

```powershell
node node_modules/esbuild/bin/esbuild ./scripts/2gis-dataset/import-snapshot.ts --bundle --platform=node --target=node22 --format=cjs --outfile=./dist/scripts/import-2gis-snapshot.cjs --external:pg
node dist/scripts/import-2gis-snapshot.cjs `
  --file "C:\Users\wemd1\Desktop\Portal\outputs\2gis-russia-csv-2026-07-26\2gis-russia-deduplicated-2026-07-26.csv" `
  --sha256 d8d7e9dad4ea398d1907c2c536d2c7e2fcf8f60ce67a699403e98409d5294ba0 `
  --snapshot-date 2026-07-26 `
  --expected-source-rows 4284928 `
  --expected-accepted-rows 4284927
```

The importer:

1. verifies the full source SHA-256 before connecting;
2. verifies the exact database and schema;
3. strips the physical `sep=;` line, verifies the exact names and order of all
   14 source columns, then streams data into an UNLOGGED staging table through
   PostgreSQL `COPY`;
4. rejects the known blank-ID row and refuses duplicate non-empty IDs or
   unexpected counts;
5. preserves the original comma-separated `subcategory` field for CSV while
   building normalized one-rubric membership rows for complete filtering;
6. replaces cards and indexes in one transaction, rebuilds facets, writes an
   immutable audit snapshot, and verifies
   `count(*) = count(distinct id) = 4,284,927`.

Re-running the same verified source is idempotent: when its SHA-256 is already
the current audited snapshot, live counts still match, and normalized
subcategory membership/facets are present, the importer returns
`already_current` without rewriting the tables.

The exclusive advisory lock prevents a supported export from crossing a
snapshot replacement. Run the import in a maintenance window because searches
can wait while the final transaction replaces the live rows.

Runtime exports use a pool separate from interactive search/facet requests, so
long downloads cannot consume every interactive database connection. Export
tickets bind the exact count and snapshot under one shared lock. CSV cells that
could be interpreted as spreadsheet formulas are emitted as text; coordinates
keep their original representation. IDs, postal codes, and phone numbers are
explicitly marked as spreadsheet text so Excel cannot round long identifiers
or remove leading zeroes.

## Read-only verification

```powershell
psql $env:TWOGIS_IMPORT_DATABASE_URL -v ON_ERROR_STOP=1 -f scripts/2gis-dataset/verify.sql
```

The source CSV, its SHA-256, the schema, and the audit row are the recovery
source for this derived dataset. The main Portal backup does not include this
separate logical database unless infrastructure backup configuration is
explicitly extended.
