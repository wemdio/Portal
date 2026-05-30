-- Ручной скоринг: вторая почта с домена (как в авто-пайплайне — до 2 на домен).
-- Каждая почта = отдельный контакт/лид (1 строка в CSV = 1 почта). В работу
-- идут только валидные/catch-all (как и в авто).

ALTER TABLE public.client_manual_score_rows
  ADD COLUMN IF NOT EXISTS email2 text,
  ADD COLUMN IF NOT EXISTS email2_validation_status text;

COMMENT ON COLUMN public.client_manual_score_rows.email2 IS
  'Вторая почта с домена (если найдено ≥2). Каждая почта — отдельный лид/строка.';
COMMENT ON COLUMN public.client_manual_score_rows.email2_validation_status IS
  'SMTP-статус второй почты (valid/role_address/free_provider/catch_all/...).';
