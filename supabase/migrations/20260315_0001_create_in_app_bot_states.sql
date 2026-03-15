-- Runtime start/stop state for bots running inside portal process (no Docker container).
CREATE TABLE IF NOT EXISTS public.in_app_bot_states (
    bot_id text PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.set_current_timestamp_in_app_bot_states()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_current_timestamp_in_app_bot_states ON public.in_app_bot_states;
CREATE TRIGGER set_current_timestamp_in_app_bot_states
BEFORE UPDATE ON public.in_app_bot_states
FOR EACH ROW
EXECUTE PROCEDURE public.set_current_timestamp_in_app_bot_states();

INSERT INTO public.in_app_bot_states (bot_id, enabled)
VALUES ('tg-agent', true)
ON CONFLICT (bot_id) DO NOTHING;
