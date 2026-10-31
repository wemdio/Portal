-- Persist a single optional RU rescue across concurrent preview/supply bases.
-- Deliberately no base FK: deleting a base must not reopen the same hypothesis.
create table if not exists public.ve_ru_website_rescue_claims (
  project_id uuid not null references public.ve_projects(id) on delete cascade,
  hypothesis_id uuid not null references public.ve_hypotheses(id) on delete cascade,
  base_id uuid not null,
  rescue_id uuid not null unique,
  claimed_at timestamptz not null default clock_timestamp(),
  primary key (project_id, hypothesis_id)
);

create index if not exists ve_ru_website_rescue_claims_hypothesis_idx
  on public.ve_ru_website_rescue_claims(hypothesis_id);

alter table public.ve_ru_website_rescue_claims enable row level security;
revoke all on table public.ve_ru_website_rescue_claims from public, anon, authenticated, service_role;
grant select, insert on table public.ve_ru_website_rescue_claims to service_role;
drop policy if exists ve_ru_website_rescue_claims_service on public.ve_ru_website_rescue_claims;
create policy ve_ru_website_rescue_claims_service on public.ve_ru_website_rescue_claims
  for all to service_role using (true) with check (true);

notify pgrst, 'reload schema';
