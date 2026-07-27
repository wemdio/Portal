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

## Install the schema

Run only after independently checking the target URL:

```powershell
psql $env:TWOGIS_IMPORT_DATABASE_URL -v ON_ERROR_STOP=1 -f scripts/2gis-dataset/001_schema.sql
```

The SQL file also aborts unless the target database is exactly
`2gis_dataset`.

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
