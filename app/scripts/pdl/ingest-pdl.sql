-- One-time ingest of the People Data Labs Free Company Dataset (CC BY 4.0)
-- into public.pdl_companies, filtered to EU/US + companies that have a website.
-- Run with DuckDB (single binary): see README.md in this folder.
--
-- DuckDB reads the Parquet straight from the HuggingFace mirror, filters,
-- dedups on id (the mirror has per-location duplicate rows), and writes to the
-- prod Postgres in one statement.

INSTALL httpfs;   LOAD httpfs;
INSTALL postgres; LOAD postgres;

-- Set this to the prod main-postgres connection string (144 DB-server).
-- Example: postgresql://postgres:PASSWORD@144.31.54.166:5432/postgres
ATTACH '${PG_CONN}' AS pg (TYPE postgres);

-- OPTIONAL: confirm the real column names first (uncomment, run, then re-run insert).
-- DESCRIBE SELECT * FROM read_parquet('hf://datasets/andreaaltomani/company-dataset@~parquet/default/train/*.parquet') LIMIT 1;

-- For a re-run, clear first (DuckDB's postgres writer has no ON CONFLICT):
-- DELETE FROM pg.public.pdl_companies;

INSERT INTO pg.public.pdl_companies
  (id, name, website, industry, size, country, region, locality, founded, linkedin_url)
SELECT
  id,
  any_value(name)        AS name,
  any_value(website)     AS website,
  any_value(industry)    AS industry,
  any_value(size)        AS size,
  any_value(country)     AS country,
  any_value(region)      AS region,
  any_value(locality)    AS locality,
  TRY_CAST(any_value(founded) AS INTEGER) AS founded,
  any_value(linkedin_url) AS linkedin_url
FROM read_parquet('hf://datasets/andreaaltomani/company-dataset@~parquet/default/train/*.parquet')
WHERE website IS NOT NULL AND website <> ''
  AND name IS NOT NULL AND name <> ''
  AND country IN (
    'united states','united kingdom','germany','france','netherlands','spain',
    'italy','ireland','sweden','poland','belgium','switzerland','austria',
    'denmark','norway','finland','portugal','canada','australia'
  )
GROUP BY id;

-- Stats
SELECT count(*) AS rows_loaded, count(DISTINCT country) AS countries
FROM pg.public.pdl_companies;
