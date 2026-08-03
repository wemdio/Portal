-- OPTIONAL enrichment: fill website / industry / linkedin for SEC Form D rows
-- (which have no website/description) from the PDL catalog, matched by
-- NORMALIZED company name: lowercase, punctuation stripped, legal/generic
-- suffixes removed (inc, llc, corp, holdings, investments, ...). SEC issuer
-- names are legal entities ("WYTEC INTERNATIONAL INC") while PDL keeps brand
-- names ("wytec") — exact-name matching found only ~4%, normalized matching
-- measured ~28% on a 2000-row sample (2026-08-02).
--
-- False-positive guards (short/generic normalized names mis-attribute, e.g.
-- "1001 Partners, LLC" -> 1001milesltd.com): normalized name must be at
-- least 5 chars and contain a letter. Unmatched rows simply keep website=NULL
-- rather than getting somebody else's site.
--
-- Run against the operational database (the same $DATABASE_URL the portal
-- container uses) after ingest-sec-formd.mjs:
--   psql "$DATABASE_URL" -f scripts/funded/enrich-sec-from-pdl.sql
--
-- Runtime: the pdl_norm pass scans pdl_companies once (~13M rows with
-- website) — a few minutes. Idempotent: only rows with website IS NULL are
-- touched, so re-runs after new SEC ingests only process the delta.

-- Normalization shared by both sides: lowercase -> punctuation to spaces ->
-- cut legal/generic suffix words -> collapse spaces.
with sec_norm as (
  select f.id,
         trim(regexp_replace(
                regexp_replace(
                  regexp_replace(lower(f.name), '[[:punct:]]', ' ', 'g'),
                  '\m(inc|incorporated|corp|corporation|llc|llp|lc|lp|lllp|ltd|limited|company|co|holdings|holding|group|partners|partner|ventures|venture|capital|capitals|management|mgr|enterprises|enterprise|international|intl|properties|investments|investment|fund|funds)\M',
                  '', 'gi'),
                '\s+', ' ', 'g')) as norm
  from public.funded_companies f
  where f.source = 'sec_formd'
    and f.website is null
),
pdl_norm as (
  select distinct on (norm)
         norm, website, industry, linkedin_url
  from (
    select website, industry, linkedin_url,
           trim(regexp_replace(
                  regexp_replace(
                    regexp_replace(lower(name), '[[:punct:]]', ' ', 'g'),
                    '\m(inc|incorporated|corp|corporation|llc|llp|lc|lp|lllp|ltd|limited|company|co|holdings|holding|group|partners|partner|ventures|venture|capital|capitals|management|mgr|enterprises|enterprise|international|intl|properties|investments|investment|fund|funds)\M',
                    '', 'gi'),
                  '\s+', ' ', 'g')) as norm
    from public.pdl_companies
    where website is not null
  ) t
  where length(norm) >= 5 and norm ~ '[a-z]'
  order by norm, (industry is not null) desc, length(website)
)
update public.funded_companies f
set website      = p.website,
    industry     = coalesce(f.industry, p.industry),
    linkedin_url = coalesce(f.linkedin_url, p.linkedin_url),
    updated_at   = now()
from sec_norm s
join pdl_norm p on p.norm = s.norm
where f.id = s.id
  and length(s.norm) >= 5
  and s.norm ~ '[a-z]';

-- Report how many SEC rows now have a website.
select
  count(*)                               as sec_rows,
  count(*) filter (where website is not null) as with_website
from public.funded_companies
where source = 'sec_formd';
