-- Store per-period commercial terms for renewed projects.

alter table public.project_periods
  add column if not exists budget text,
  add column if not exists margin text,
  add column if not exists payment_date date;
