-- Public website observations shared across VE2 hypotheses. No audience
-- verdicts, imported client rows, email validation or project data go here.
create table if not exists public.ve_company_fact_pages (
  company_key text not null,
  page_key text not null,
  reader_version integer not null,
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  page jsonb not null,
  primary key (company_key, page_key),
  check (expires_at > observed_at),
  check (jsonb_typeof(page) = 'object')
);
create index if not exists ve_company_fact_pages_expiry_idx on public.ve_company_fact_pages (expires_at);
alter table public.ve_company_fact_pages enable row level security;
revoke all on public.ve_company_fact_pages from public, anon, authenticated;
grant all on public.ve_company_fact_pages to service_role;
comment on table public.ve_company_fact_pages is 'VE2 identity-verified public source documents; relevance and email checks remain hypothesis-local.';

-- A slower concurrent hypothesis must not replace a more recent observation.
create or replace function public.ve_company_fact_keep_newer()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.observed_at < old.observed_at then return old; end if;
  return new;
end;
$$;
revoke all on function public.ve_company_fact_keep_newer() from public, anon, authenticated;
grant execute on function public.ve_company_fact_keep_newer() to service_role;
drop trigger if exists ve_company_fact_keep_newer on public.ve_company_fact_pages;
create trigger ve_company_fact_keep_newer before update on public.ve_company_fact_pages
for each row execute function public.ve_company_fact_keep_newer();
