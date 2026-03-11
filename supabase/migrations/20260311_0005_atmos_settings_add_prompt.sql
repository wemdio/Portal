-- Add system_prompt column to atmos settings for runtime prompt editing via bot commands

ALTER TABLE public.tg_atmos_settings
    ADD COLUMN IF NOT EXISTS system_prompt text NOT NULL DEFAULT '';
