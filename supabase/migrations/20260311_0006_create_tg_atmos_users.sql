-- Atmos-bot: users table for per-specialist analytics

CREATE TABLE IF NOT EXISTS public.tg_atmos_users (
    user_id         bigint PRIMARY KEY,
    username        text,
    full_name       text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz
);

CREATE INDEX IF NOT EXISTS tg_atmos_users_last_message_idx
    ON public.tg_atmos_users (last_message_at DESC);

