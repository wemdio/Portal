-- Manual employee reviews for the Team page.
--
-- Reads are intentionally narrow:
--   * lead/director/admin can see every review;
--   * any other internal employee can see only reviews about themselves;
--   * clients and anonymous users see nothing.
--
-- All mutations go through /api/team/reviews with the service-role client.
-- There are deliberately no authenticated INSERT/UPDATE/DELETE grants or RLS
-- policies, so the browser cannot spoof reviewer_user_id.

create table if not exists public.employee_reviews (
  id uuid primary key default gen_random_uuid(),
  review_date date not null,
  employee_user_id uuid not null,
  reviewer_user_id uuid,
  outcomes text not null,
  problems text,
  recommendations text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint employee_reviews_employee_user_id_fkey
    foreign key (employee_user_id)
    references public.profiles(id)
    on delete restrict,

  constraint employee_reviews_reviewer_user_id_fkey
    foreign key (reviewer_user_id)
    references public.profiles(id)
    on delete set null,

  constraint employee_reviews_outcomes_length_check
    check (char_length(btrim(outcomes)) between 1 and 5000),

  constraint employee_reviews_problems_length_check
    check (problems is null or char_length(problems) <= 5000),

  constraint employee_reviews_recommendations_length_check
    check (recommendations is null or char_length(recommendations) <= 5000)
);

create index if not exists idx_employee_reviews_review_date
  on public.employee_reviews(review_date desc, created_at desc);

create index if not exists idx_employee_reviews_employee_date
  on public.employee_reviews(employee_user_id, review_date desc, created_at desc);

drop trigger if exists trg_employee_reviews_updated_at on public.employee_reviews;
create trigger trg_employee_reviews_updated_at
  before update on public.employee_reviews
  for each row execute function public.set_updated_at();

grant all on public.employee_reviews to postgres;
grant all on public.employee_reviews to service_role;

revoke all on public.employee_reviews from anon;
revoke all on public.employee_reviews from authenticated;
grant select on public.employee_reviews to authenticated;

alter table public.employee_reviews enable row level security;

drop policy if exists employee_reviews_internal_read on public.employee_reviews;
create policy employee_reviews_internal_read
  on public.employee_reviews
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles actor
      where actor.id = auth.uid()
        and actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
        and coalesce(actor.is_demo, false) = false
        and (
          actor.role in ('lead', 'director', 'admin')
          or employee_reviews.employee_user_id = auth.uid()
        )
    )
  );

comment on table public.employee_reviews is
  'Manual employee reviews shown on the Team page; mutations are service-role API only.';

comment on column public.employee_reviews.reviewer_user_id is
  'Session user that created the review. Preserved on edits; SET NULL if the profile is deleted.';
