-- Add 'client' to the profiles role CHECK constraint.
-- The constraint was originally created outside of tracked migrations.

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role = ANY (ARRAY[
    'technician'::text,
    'manager'::text,
    'director'::text,
    'admin'::text,
    'sales'::text,
    'marketer'::text,
    'lead'::text,
    'client'::text
  ]));
