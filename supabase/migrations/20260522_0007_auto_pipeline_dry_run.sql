-- Dry-run mode for the HH auto-pipeline.
--
-- Когда client_auto_pipeline_configs.dry_run = true оркестратор всё ещё:
--   1. Парсит HH (findNewHhEmployers)
--   2. Дедупит против seen_employers
--   3. Получает score от Mailganer endpoint
--   4. Скрейпит email с сайта компании
--   5. Валидирует email (DNS + MX + SMTP-проверка)
--   6. Пишет результат каждого employer'а в seen_employers
--
-- НО НЕ делает:
--   ❌ Не проверяет bootstrap'нутость bucket'ов
--   ❌ Не создаёт лидов в Instantly
--   ❌ Не загружает в кампании
--
-- Цель: оценить размер «воронки» (parsed → with_email → email_valid)
-- ДО того как впервые написать клиентам. Замеряем сколько в день выходит
-- готовых валидных контактов — чтобы клиент мог оценить достижимость
-- своего месячного объёма.
--
-- Включить ровно на одного клиента:
--   UPDATE public.client_auto_pipeline_configs
--      SET dry_run = true, enabled = true
--    WHERE client_user_id = '<uuid>';
--   UPDATE public.profiles
--      SET auto_pipeline_enabled = true
--    WHERE id = '<uuid>';

ALTER TABLE public.client_auto_pipeline_configs
  ADD COLUMN IF NOT EXISTS dry_run boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.client_auto_pipeline_configs.dry_run IS
  'Когда true — оркестратор делает enrichment (HH + scoring + email scrape + validation), но не отправляет в Instantly. Все данные сохраняются в seen_employers для аналитики воронки.';

-- Расширяем seen_employers, чтобы хранить детали email-валидации.
-- email_found — что собственно нашёл скрейпер (первая запись из scrape.emails).
-- email_validation_status — короткий вердикт: valid | invalid_syntax | no_mx |
--   smtp_reject | smtp_unknown | role_address | free_provider | disposable.
-- email_validation_details — полный объект validator'а, для отладки конкретных
--   случаев.

ALTER TABLE public.client_auto_pipeline_seen_employers
  ADD COLUMN IF NOT EXISTS email_found text,
  ADD COLUMN IF NOT EXISTS email_validation_status text,
  ADD COLUMN IF NOT EXISTS email_validation_details jsonb;

-- Расширяем CHECK на status, чтобы принять 'dry_run' — отдельный статус для
-- employers'ов из dry-run прогона. Drop+add потому что Postgres не умеет
-- модифицировать existing CHECK in-place.
ALTER TABLE public.client_auto_pipeline_seen_employers
  DROP CONSTRAINT IF EXISTS client_auto_pipeline_seen_employers_status_check;
ALTER TABLE public.client_auto_pipeline_seen_employers
  ADD CONSTRAINT client_auto_pipeline_seen_employers_status_check
  CHECK (status IN ('enqueued', 'routed', 'stored', 'skipped', 'failed', 'dry_run'));

COMMENT ON COLUMN public.client_auto_pipeline_seen_employers.email_found IS
  'Первый email, найденный stepFindEmails при скрейпе сайта компании. null если ничего не найдено.';
COMMENT ON COLUMN public.client_auto_pipeline_seen_employers.email_validation_status IS
  'Короткий вердикт email-валидатора: valid | invalid_syntax | no_mx | smtp_reject | smtp_unknown | role_address | free_provider | disposable | not_validated';
COMMENT ON COLUMN public.client_auto_pipeline_seen_employers.email_validation_details IS
  'Полный ответ lib/emailValidation/validator: syntax check, MX hosts, SMTP-результат. Для отладки.';

-- Расширяем journal таблицу client_auto_pipeline_runs воронкой —
-- чтобы дашборд показал клиенту цифры стадий.

ALTER TABLE public.client_auto_pipeline_runs
  ADD COLUMN IF NOT EXISTS with_site integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS with_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS with_email integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_valid integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS was_dry_run boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.client_auto_pipeline_runs.with_site IS
  'Сколько employers имели site_url после HH-обогащения.';
COMMENT ON COLUMN public.client_auto_pipeline_runs.with_score IS
  'Сколько успешно получили score от Mailganer endpoint.';
COMMENT ON COLUMN public.client_auto_pipeline_runs.with_email IS
  'Сколько успешно отскрейпили хотя бы один email с сайта.';
COMMENT ON COLUMN public.client_auto_pipeline_runs.email_valid IS
  'Сколько прошли DNS+MX+SMTP-валидацию. Это «готовые контакты».';
COMMENT ON COLUMN public.client_auto_pipeline_runs.was_dry_run IS
  'Был ли это dry-run прогон (без отправки в Instantly).';
