-- Sales Copilot: inline session — менеджер подключает свой TG-аккаунт напрямую

ALTER TABLE public.sales_copilot_configs
  ADD COLUMN IF NOT EXISTS session_data jsonb,
  ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tg_first_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tg_username text NOT NULL DEFAULT '';

-- account_id больше не обязателен (новые конфиги хранят session inline)
ALTER TABLE public.sales_copilot_configs
  ALTER COLUMN account_id DROP NOT NULL;

-- Обновить unique constraint: user_id уникален сам по себе (один copilot на пользователя)
ALTER TABLE public.sales_copilot_configs
  DROP CONSTRAINT IF EXISTS sales_copilot_configs_user_id_account_id_key;

-- Убрать FK на tg_pool_accounts чтобы не зависеть от пула
ALTER TABLE public.sales_copilot_configs
  DROP CONSTRAINT IF EXISTS sales_copilot_configs_account_id_fkey;

-- Аналогично в drafts: account_id nullable, убрать FK
ALTER TABLE public.sales_copilot_drafts
  ALTER COLUMN account_id DROP NOT NULL;

ALTER TABLE public.sales_copilot_drafts
  DROP CONSTRAINT IF EXISTS sales_copilot_drafts_account_id_fkey;
