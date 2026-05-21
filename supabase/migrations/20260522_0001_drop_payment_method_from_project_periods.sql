-- Remove the accidental period-level payment method field.

alter table public.project_periods
  drop column if exists payment_method;
