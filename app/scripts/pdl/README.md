# EU/US company catalog — data ingest (People Data Labs Free Company Dataset)

Powers the **«EU/US · База компаний»** tab. One-time load of a free, CC BY 4.0
firmographic dataset (~22M companies → ~6–9M after the EU/US + has-website filter)
into `public.pdl_companies`.

- **Source:** People Data Labs Free Company Dataset, via the HuggingFace mirror
  `andreaaltomani/company-dataset` (Parquet, pure CC BY 4.0, scriptable).
- **License:** CC BY 4.0 — commercial use allowed; **attribution required**
  («Company data: People Data Labs, CC BY 4.0», уже встроена в футер вкладки и в экспорт).
- **Fields:** id, name, website, industry (~147 LinkedIn enums), size bucket,
  country, region, locality, founded, linkedin_url. **No prose description** —
  it's synthesized (industry+гео) and upgraded on-demand by the website scraper.

## Steps (run once, on a box with disk + network + access to prod Postgres)

1. **Apply the migration** (creates `pdl_companies` + RLS):
   `supabase/migrations/20260609_0001_create_pdl_companies.sql` → в текущую production main-БД.

2. **Install DuckDB** (single binary): https://duckdb.org/docs/installation/
   ```bash
   curl -L https://github.com/duckdb/duckdb/releases/latest/download/duckdb_cli-linux-amd64.zip -o d.zip && unzip d.zip
   ```

3. **Run the ingest**, passing the prod Postgres connection string:
   ```bash
   PG_CONN='<current production DATABASE_URL>'
   sed "s|\${PG_CONN}|$PG_CONN|" ingest-pdl.sql | ./duckdb
   ```
   DuckDB streams the Parquet from HuggingFace, filters EU/US + has-website,
   dedups on `id`, and bulk-inserts into Postgres. Expect ~6–9M rows, a few minutes
   to ~20 min depending on bandwidth.

4. **Verify:** the final `SELECT count(*)` should print millions of rows.
   `ANALYZE public.pdl_companies;` (optional, refreshes planner stats).

## Notes

- **Re-running / refresh:** the HF mirror is a frozen 2025 snapshot. To refresh,
  `DELETE FROM public.pdl_companies;` then re-run (DuckDB's Postgres writer has no
  `ON CONFLICT`; the table dedups on `id` so a clean reload is simplest). The
  official quarterly cut is at https://www.peopledatalabs.com/company-dataset.
- **Column names:** if the insert errors on a column, uncomment the `DESCRIBE`
  line in `ingest-pdl.sql` to print the mirror's actual headers and adjust.
- **Faster load:** for the very first load you can `DROP INDEX` the three
  `idx_pdl_companies_*` indexes, load, then recreate them (`create index …` from
  the migration is idempotent). Not required.
- **Widen coverage:** edit the `country IN (...)` list in `ingest-pdl.sql`.
