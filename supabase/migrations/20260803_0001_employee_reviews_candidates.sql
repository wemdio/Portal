-- Allow reviews to target either an internal employee profile or a candidate
-- entered manually. Existing employee reviews remain unchanged.

alter table public.employee_reviews
  add column if not exists candidate_name text;

alter table public.employee_reviews
  add constraint employee_reviews_subject_check
    check (
      (
        employee_user_id is not null
        and candidate_name is null
      )
      or
      (
        employee_user_id is null
        and candidate_name is not null
        and candidate_name = btrim(candidate_name)
        and char_length(candidate_name) between 1 and 200
      )
    ) not valid;

alter table public.employee_reviews
  validate constraint employee_reviews_subject_check;

alter table public.employee_reviews
  alter column employee_user_id drop not null;

comment on column public.employee_reviews.candidate_name is
  'Candidate name when a review is not linked to an internal employee profile.';
