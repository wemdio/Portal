create table if not exists client_companies_search_exports (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  row_count   integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists client_companies_search_exports_user_created_idx
  on client_companies_search_exports (user_id, created_at);

alter table client_companies_search_exports enable row level security;

grant select, insert on client_companies_search_exports to service_role;
