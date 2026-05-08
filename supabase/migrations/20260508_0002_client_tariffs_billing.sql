ALTER TABLE public.client_tariffs
  ADD COLUMN paid_at timestamptz,
  ADD COLUMN paid_until timestamptz,
  ADD COLUMN setup_until timestamptz,
  ADD COLUMN is_active boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.client_tariffs.paid_at IS 'Date of last payment';
COMMENT ON COLUMN public.client_tariffs.setup_until IS 'End of the setup phase (paid_at + 3 days). Client is blocked until this date passes or admin finishes setup early.';
COMMENT ON COLUMN public.client_tariffs.paid_until IS 'End of the billing period (setup_until + 1 month). Limits are counted from setup_until to paid_until.';
COMMENT ON COLUMN public.client_tariffs.is_active IS 'Whether the subscription is paid and not expired';
