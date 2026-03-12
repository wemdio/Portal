-- Mute/unmute health-check alerts via Telegram commands (/mute, /вкл).
-- Used by services/health-check.
CREATE TABLE IF NOT EXISTS public.health_check_settings (
    id int PRIMARY KEY DEFAULT 1,
    send_alerts boolean NOT NULL DEFAULT true
);

INSERT INTO public.health_check_settings (id, send_alerts) VALUES (1, true)
ON CONFLICT (id) DO NOTHING;
