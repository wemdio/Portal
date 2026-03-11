-- Atmos-bot: singleton settings table for runtime configuration via Telegram commands

CREATE TABLE IF NOT EXISTS public.tg_atmos_settings (
    id                   int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    model                text NOT NULL DEFAULT 'google/gemini-2.0-flash-001',
    check_interval_sec   int NOT NULL DEFAULT 300,
    stats_interval_sec   int NOT NULL DEFAULT 3600,
    negative_threshold   real NOT NULL DEFAULT 0.30,
    updated_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.tg_atmos_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
