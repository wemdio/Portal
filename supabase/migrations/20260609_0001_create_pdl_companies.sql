-- EU/US company catalog from the People Data Labs Free Company Dataset (CC BY 4.0).
-- Reference data (NOT per-user job results): one shared table, read-only to all
-- authenticated users, written only by the one-time ingest script (service_role).
-- Attribution required by CC BY 4.0: "Company data: People Data Labs, CC BY 4.0".

create table if not exists public.pdl_companies (
  id            text primary key,          -- PDL company id (dedup key)
  name          text not null,
  website       text,                       -- bare domain; ingest keeps only non-null
  industry      text,                       -- LinkedIn industry enum (~147), lowercased
  size          text,                       -- bucket: '1-10','11-50','51-200','201-500','501-1000','1001-5000','5001-10000','10001+'
  country       text,                       -- lowercased, e.g. 'united states'
  region        text,                       -- state/province
  locality      text,                       -- city
  founded       integer,
  linkedin_url  text,
  -- description enrichment (filled on-demand by the website scraper; null until then)
  description            text,
  description_source     text,              -- 'website_meta' | 'website_about' | null
  description_fetched_at timestamptz,
  created_at    timestamptz not null default now()
);

-- Indexes are created AFTER the bulk load by the ingest script (much faster).
-- They are declared here idempotently so re-running the migration is safe.
create index if not exists idx_pdl_companies_filter on public.pdl_companies (country, industry, size);
create index if not exists idx_pdl_companies_country_size on public.pdl_companies (country, size);
create index if not exists idx_pdl_companies_no_desc on public.pdl_companies (id) where description is null;

alter table public.pdl_companies enable row level security;

-- Reference catalog: any authenticated user may read; only service_role writes.
drop policy if exists pdl_companies_select_authenticated on public.pdl_companies;
create policy pdl_companies_select_authenticated
  on public.pdl_companies for select to authenticated using (true);

grant select on public.pdl_companies to authenticated;
grant all on public.pdl_companies to service_role;

-- Facets for the filter dropdowns: distinct industry / country / size with counts.
-- Cached at the route layer; the GROUP BYs run at most a few times per hour.
create or replace function public.pdl_facets()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'industries', (
      select coalesce(jsonb_agg(jsonb_build_object('value', industry, 'count', c) order by c desc), '[]'::jsonb)
      from (select industry, count(*) c from pdl_companies where industry is not null group by industry) t
    ),
    'countries', (
      select coalesce(jsonb_agg(jsonb_build_object('value', country, 'count', c) order by c desc), '[]'::jsonb)
      from (select country, count(*) c from pdl_companies where country is not null group by country) t
    ),
    'sizes', (
      select coalesce(jsonb_agg(jsonb_build_object('value', size, 'count', c) order by c desc), '[]'::jsonb)
      from (select size, count(*) c from pdl_companies where size is not null group by size) t
    )
  );
$$;

grant execute on function public.pdl_facets() to authenticated;
