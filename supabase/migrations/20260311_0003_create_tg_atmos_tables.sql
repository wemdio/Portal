-- Atmos-bot: tables for chat atmosphere monitoring

CREATE TABLE IF NOT EXISTS public.tg_atmos_messages (
    chat_id       bigint NOT NULL,
    message_id    bigint NOT NULL,
    sender_id     bigint NOT NULL DEFAULT 0,
    sender_name   text NOT NULL DEFAULT '',
    text          text NOT NULL DEFAULT '',
    chat_title    text NOT NULL DEFAULT '',
    chat_username text,
    sent_at       timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    processed_at  timestamptz,
    PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS tg_atmos_messages_unprocessed_idx
    ON public.tg_atmos_messages (chat_id, message_id ASC)
    WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.tg_atmos_checks (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chat_id            bigint NOT NULL,
    window_from        bigint NOT NULL,
    window_to          bigint NOT NULL,
    total_count        int NOT NULL DEFAULT 0,
    negative_count     int NOT NULL DEFAULT 0,
    sentiment_score    real NOT NULL DEFAULT 0.5,
    risk_level         text NOT NULL DEFAULT 'low',
    reasons            text NOT NULL DEFAULT '[]',
    recommended_action text NOT NULL DEFAULT '',
    summary            text NOT NULL DEFAULT '',
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tg_atmos_checks_chat_created_idx
    ON public.tg_atmos_checks (chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.tg_atmos_chat_state (
    chat_id                    bigint PRIMARY KEY,
    chat_title                 text NOT NULL DEFAULT '',
    chat_username              text,
    last_processed_message_id  bigint NOT NULL DEFAULT 0,
    last_hourly_sent_at        timestamptz,
    created_at                 timestamptz NOT NULL DEFAULT now()
);
