-- "Crunchbase-style" catalog of companies + funding/rounds, US/global.
-- Reference data (NOT per-user job results): one shared table, read-only to all
-- authenticated users, written only by the ingest scripts (service_role).
--
-- Source-agnostic by design: every row carries a `source` tag, and a synthetic
-- `id` of the form `<source>:<natural_key>`. Free sources today:
--   'yc'        — Y Combinator OSS API (name/website/long description/batch/stage)
--   'sec_formd' — SEC EDGAR Form D (US private funding events; enriched w/ website)
--   'pdl'       — People Data Labs firmographics (enrichment join source)
-- A paid bulk source (e.g. Bright Data Crunchbase dataset) can be dropped in
-- later as source='brightdata' via one ingest script — no API/UI changes needed.
--
-- Attribution kept per-source in the export footer (YC: permissive; SEC: public
-- domain; PDL: CC BY 4.0).

create table if not exists public.funded_companies (
  id                  text primary key,        -- '<source>:<natural_key>'
  source              text not null,           -- 'yc' | 'sec_formd' | 'pdl' | 'brightdata'
  name                text not null,
  website             text,                     -- bare domain or full URL
  description         text,                     -- prose (YC long_description, scrape, etc.)
  short_description   text,                     -- one-liner (YC one_liner)
  industry            text,                     -- lowercased label where possible
  country             text,                     -- lowercased, e.g. 'united states'
  region              text,                     -- state/province
  locality            text,                     -- city
  founded             integer,                  -- year
  linkedin_url        text,
  -- funding / rounds
  total_funding_usd   bigint,                   -- cumulative raised, if known
  last_funding_usd    bigint,                   -- most recent round / offering amount (USD)
  last_funding_type   text,                     -- 'seed'|'series_a'|...|'reg_d' (Form D) | YC stage
  last_funding_date   date,
  num_funding_rounds  integer,
  investors           text,                     -- comma-joined names, if known
  funding_detail      jsonb,                    -- raw per-round / source-specific extras
  -- source meta
  source_url          text,                     -- link back (YC page, SEC filing index, etc.)
  batch               text,                     -- YC batch e.g. 'W21'
  stage               text,                     -- company stage (YC: 'Active'/'Acquired'/...)
  team_size           integer,
  tags                text[],                   -- YC tags / categories
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Indexes are (re)created idempotently. Created after bulk load by the ingest
-- script for speed, but declared here so re-running the migration is safe.
create index if not exists idx_funded_filter        on public.funded_companies (source, country, industry);
create index if not exists idx_funded_country_ind    on public.funded_companies (country, industry);
create index if not exists idx_funded_last_funding   on public.funded_companies (last_funding_date desc nulls last);
create index if not exists idx_funded_stage          on public.funded_companies (last_funding_type);
-- "has funding" partial index for the most common filter.
create index if not exists idx_funded_has_funding    on public.funded_companies (id)
  where last_funding_date is not null or last_funding_usd is not null or total_funding_usd is not null;
-- enrichment helper: Form D rows still missing a website.
create index if not exists idx_funded_no_site        on public.funded_companies (id)
  where website is null;

alter table public.funded_companies enable row level security;

-- Reference catalog: any authenticated user may read; only service_role writes.
drop policy if exists funded_companies_select_authenticated on public.funded_companies;
create policy funded_companies_select_authenticated
  on public.funded_companies for select to authenticated using (true);

grant select on public.funded_companies to authenticated;
grant all    on public.funded_companies to service_role;

-- Facets for the filter dropdowns: distinct source / country / industry / stage
-- with counts. Cached at the route layer; the GROUP BYs run a few times per hour.
create or replace function public.funded_facets()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'sources', (
      select coalesce(jsonb_agg(jsonb_build_object('value', source, 'count', c) order by c desc), '[]'::jsonb)
      from (select source, count(*) c from funded_companies where source is not null group by source) t
    ),
    'countries', (
      select coalesce(jsonb_agg(jsonb_build_object('value', country, 'count', c) order by c desc), '[]'::jsonb)
      from (select country, count(*) c from funded_companies where country is not null group by country) t
    ),
    'industries', (
      select coalesce(jsonb_agg(jsonb_build_object('value', industry, 'count', c) order by c desc), '[]'::jsonb)
      from (select industry, count(*) c from funded_companies where industry is not null group by industry) t
    ),
    'stages', (
      select coalesce(jsonb_agg(jsonb_build_object('value', last_funding_type, 'count', c) order by c desc), '[]'::jsonb)
      from (select last_funding_type, count(*) c from funded_companies where last_funding_type is not null group by last_funding_type) t
    )
  );
$$;

grant execute on function public.funded_facets() to authenticated;
