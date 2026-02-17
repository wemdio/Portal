-- Payment requests: employee expense approval workflow
create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  department text not null check (department in ('outreach', 'paid_traffic', 'accounting', 'sales')),
  description text not null,
  amount numeric(12, 2) not null check (amount > 0),
  project_id uuid references public.projects(id) on delete set null,
  comment text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamp with time zone,
  decision_comment text,
  created_at timestamp with time zone not null default now()
);

-- Indexes
create index if not exists idx_payment_requests_user_id on public.payment_requests(user_id);
create index if not exists idx_payment_requests_status on public.payment_requests(status);
create index if not exists idx_payment_requests_created_at on public.payment_requests(created_at desc);
create index if not exists idx_payment_requests_department on public.payment_requests(department);

-- RLS
alter table public.payment_requests enable row level security;

-- All authenticated users can see all requests (team transparency)
drop policy if exists payment_requests_select_all on public.payment_requests;
create policy payment_requests_select_all
  on public.payment_requests
  for select
  using (auth.uid() is not null);

-- Any authenticated user can create a request
drop policy if exists payment_requests_insert_own on public.payment_requests;
create policy payment_requests_insert_own
  on public.payment_requests
  for insert
  with check (auth.uid() = user_id);

-- Any authenticated user can update (status check is done on the client side by email)
drop policy if exists payment_requests_update_all on public.payment_requests;
create policy payment_requests_update_all
  on public.payment_requests
  for update
  using (auth.uid() is not null);
