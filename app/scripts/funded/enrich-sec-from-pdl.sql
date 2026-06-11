-- OPTIONAL enrichment: fill website / industry / linkedin for SEC Form D rows
-- (which have no website/description) from the PDL catalog, matched by exact
-- lowercased company name. Conservative on purpose — exact-name only — so it
-- never mis-attributes a website. Fuzzier matching (trigram / domain) can be
-- layered later.
--
-- Run on the main Postgres (144) after ingest-sec-formd.mjs:
--   psql "$DATABASE_URL" -f scripts/funded/enrich-sec-from-pdl.sql

-- Functional index makes the name join fast over pdl_companies (~13M rows).
create index if not exists idx_pdl_lower_name on public.pdl_companies (lower(name));

update public.funded_companies f
set website      = sub.website,
    industry     = coalesce(f.industry, sub.industry),
    linkedin_url = coalesce(f.linkedin_url, sub.linkedin_url),
    updated_at   = now()
from (
  select distinct on (lower(name))
         lower(name) as lname, website, industry, linkedin_url
  from public.pdl_companies
  where website is not null
  order by lower(name), (industry is not null) desc
) sub
where f.source = 'sec_formd'
  and f.website is null
  and lower(f.name) = sub.lname;

-- Report how many SEC rows now have a website.
select
  count(*)                               as sec_rows,
  count(*) filter (where website is not null) as with_website
from public.funded_companies
where source = 'sec_formd';
