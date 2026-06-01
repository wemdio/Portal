-- Авто-пайплайн: храним ВТОРУЮ почту домена в seen-строках.
--
-- Скрейп уже находит до 2 почт на домен (MAX_EMAILS_PER_DOMAIN=2) и валидирует
-- обе, но раньше dry-run сохранял только первичную (resolved_email) — вторая
-- лишь считалась в воронке и выбрасывалась. Теперь храним её здесь, чтобы
-- dry-run-резерв сразу нёс 2-ю почту (как в ручном скоринге, миграция 0018),
-- и при промоуте/боевом запуске домен с валидной 2-й почтой давал 2 контакта.
--
-- Зеркалит client_manual_score_rows.email2 / email2_validation_status.

ALTER TABLE public.client_auto_pipeline_seen_employers
  ADD COLUMN IF NOT EXISTS email2 text,
  ADD COLUMN IF NOT EXISTS email2_validation_status text;

COMMENT ON COLUMN public.client_auto_pipeline_seen_employers.email2 IS
  'Вторая почта домена (info@ + sales@), если скрейп нашёл 2. NULL = одна почта.';
COMMENT ON COLUMN public.client_auto_pipeline_seen_employers.email2_validation_status IS
  'Статус валидации второй почты (valid/role_address/free_provider/catch_all/…).';
