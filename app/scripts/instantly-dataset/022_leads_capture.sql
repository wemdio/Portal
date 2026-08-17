-- 022_leads_capture.sql — ночной захват карточек лидов из Instantly.
--
-- Зачем: команда постоянно чистит кампании от контактов ради места по тарифу,
-- карточка лида живёт 4–8 недель (замер 17.08.2026: из 2 576 кампаний лиды
-- остались в 304; всё старше июня — в ноль). Письма переживают чистку, карточки —
-- нет. Ночной sync.mjs теперь снимает карточки всех кампаний с leads_count>0 и
-- UPSERT-ит их в raw_leads. НИЧЕГО не удаляем: после чистки у нас остаётся
-- последний снимок (открытия/ответы/статус/домен/payload).
--
-- Идемпотентно: sync.mjs применяет этот файл при старте (как sync-portal-mirror
-- применяет 018). ADD COLUMN без DEFAULT — метаданные, без перезаписи таблицы.

ALTER TABLE raw_leads
  ADD COLUMN IF NOT EXISTS status                 SMALLINT,
  ADD COLUMN IF NOT EXISTS email_open_count       INTEGER,
  ADD COLUMN IF NOT EXISTS email_reply_count      INTEGER,
  ADD COLUMN IF NOT EXISTS email_click_count      INTEGER,
  ADD COLUMN IF NOT EXISTS email_opened_step      INTEGER,
  ADD COLUMN IF NOT EXISTS email_replied_step     INTEGER,
  ADD COLUMN IF NOT EXISTS company_domain         TEXT,
  ADD COLUMN IF NOT EXISTS verification_status    SMALLINT,
  ADD COLUMN IF NOT EXISTS esp_code               SMALLINT,
  ADD COLUMN IF NOT EXISTS upload_method          TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_by_user       TEXT,
  ADD COLUMN IF NOT EXISTS personalization        TEXT,
  ADD COLUMN IF NOT EXISTS upload_payload         JSONB,
  ADD COLUMN IF NOT EXISTS timestamp_last_contact TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timestamp_last_open    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timestamp_last_reply   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timestamp_last_click   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timestamp_last_touch   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_pulled_at        TIMESTAMPTZ;

COMMENT ON TABLE  raw_leads IS
  'Карточки лидов Instantly. С 2026-08 — ночной захват (sync.mjs): все кампании с leads_count>0, UPSERT по id, БЕЗ удалений. Строки до 2026-08 — разовый слепок мая 2026 (194 кампании, поля захвата NULL). Карточка в Instantly живёт 4–8 недель (чистка ради тарифа) — здесь остаётся последний снимок. lead_list_id у кампанийных лидов пуст (замер 17.08: 0%), носитель признаков — имя кампании (v_campaign_client / v_campaign_segment).';
COMMENT ON COLUMN raw_leads.status IS
  'Статус лида в кампании (lookup_lead_status). Наблюдалось 17.08.2026: 1 active 54%, 3 completed 35%, -1 bounced 11%.';
COMMENT ON COLUMN raw_leads.email_open_count IS
  'Открытий писем кампании этим лидом (по трекингу Instantly; сканеры завышают — как относительный сигнал «открывал / не открывал» рабочий).';
COMMENT ON COLUMN raw_leads.email_reply_count IS 'Ответов лида в этой кампании.';
COMMENT ON COLUMN raw_leads.email_click_count IS 'Кликов по ссылкам (при link_tracking).';
COMMENT ON COLUMN raw_leads.email_opened_step IS 'Шаг цепочки, на котором было первое открытие.';
COMMENT ON COLUMN raw_leads.email_replied_step IS 'Шаг цепочки, на котором был ответ.';
COMMENT ON COLUMN raw_leads.company_domain IS
  'Домен компании (Instantly выводит из email; заполнен у ~100% кампанийных лидов) — ключ для обогащения признаками компании после захвата.';
COMMENT ON COLUMN raw_leads.verification_status IS 'Статус верификации email в Instantly (их код).';
COMMENT ON COLUMN raw_leads.esp_code IS 'Код почтового провайдера получателя (их код).';
COMMENT ON COLUMN raw_leads.upload_method IS 'Как залит лид: manual (UI/CSV) / api / … Замер 17.08: 100% manual.';
COMMENT ON COLUMN raw_leads.uploaded_by_user IS 'ID пользователя Instantly, который залил лида.';
COMMENT ON COLUMN raw_leads.personalization IS 'Персонализация из CSV ({{personalization}}).';
COMMENT ON COLUMN raw_leads.upload_payload IS
  'Исходная строка CSV как её загрузили (Instantly хранит ВСЕ колонки). Типовые ключи: companyName, email, website, personalization; встречаются jobTitle, linkedIn, City, location, email_1..5/subject_1..5. Правило «не резать колонки перед заливкой» = единственный совместимый с ручными запусками способ донести признаки контакта.';
COMMENT ON COLUMN raw_leads.timestamp_last_contact IS 'Последнее касание лида кампанией.';
COMMENT ON COLUMN raw_leads.timestamp_last_open IS 'Последнее открытие.';
COMMENT ON COLUMN raw_leads.timestamp_last_reply IS 'Последний ответ.';
COMMENT ON COLUMN raw_leads.timestamp_last_click IS 'Последний клик.';
COMMENT ON COLUMN raw_leads.timestamp_last_touch IS 'Последнее любое событие по лиду.';
COMMENT ON COLUMN raw_leads.first_pulled_at IS 'Когда лид впервые попал в захват (не перезаписывается). NULL = строка из майского слепка.';
COMMENT ON COLUMN raw_leads.pulled_at IS 'Когда лида видели в Instantly в последний раз (обновляется каждым захватом). Старше ~2 месяцев при живой кампании = кампанию вычистили.';

CREATE INDEX IF NOT EXISTS raw_leads_company_domain_idx ON raw_leads(company_domain);
CREATE INDEX IF NOT EXISTS raw_leads_pulled_at_idx      ON raw_leads(pulled_at);

-- Отпечаток кампании на момент последнего захвата: если счётчики не двигались —
-- карточки не перечитываем (экономим страницы /leads/list).
CREATE TABLE IF NOT EXISTS lead_capture_state (
  campaign_id         TEXT PRIMARY KEY,
  leads_count         INTEGER,
  emails_sent_count   INTEGER,
  open_count          INTEGER,
  reply_count         INTEGER,
  bounced_count       INTEGER,
  fingerprint         TEXT,
  leads_pulled        INTEGER,
  pages               INTEGER,
  first_captured_at   TIMESTAMPTZ,
  last_captured_at    TIMESTAMPTZ,
  last_seen_leads_at  TIMESTAMPTZ,
  cleaned_at          TIMESTAMPTZ
);
COMMENT ON TABLE lead_capture_state IS
  'Служебное для sync.mjs: отпечаток счётчиков кампании (/campaigns/analytics) на момент последнего захвата лидов. cleaned_at = первая ночь, когда leads_count упал в 0 после >0 (кампанию вычистили). last_seen_leads_at = последняя ночь с leads_count>0.';

CREATE TABLE IF NOT EXISTS lookup_lead_status (
  value       SMALLINT PRIMARY KEY,
  label       TEXT NOT NULL,
  label_ru    TEXT NOT NULL,
  description TEXT
);
INSERT INTO lookup_lead_status (value, label, label_ru, description) VALUES
  ( 1, 'active',       'В работе',    'Лид в цепочке кампании (наблюдалось 17.08.2026: 54% выборки).'),
  ( 2, 'paused',       'На паузе',    'Лид приостановлен (по описанию поля Lead.status в Instantly v2; в выборке 17.08 не встречался).'),
  ( 3, 'completed',    'Завершён',    'Цепочка пройдена до конца (наблюдалось: 35%).'),
  (-1, 'bounced',      'Баунс',       'Письмо не доставлено (наблюдалось: 11%).'),
  (-2, 'unsubscribed', 'Отписался',   'По описанию поля Lead.status в Instantly v2; в выборке 17.08 не встречался.'),
  (-3, 'skipped',      'Пропущен',    'По описанию поля Lead.status в Instantly v2; в выборке 17.08 не встречался.')
ON CONFLICT (value) DO NOTHING;
COMMENT ON TABLE lookup_lead_status IS
  'raw_leads.status. Значения 1/3/-1 подтверждены замером 17.08.2026; 2/-2/-3 — из описания поля Lead.status в Instantly v2 (не встречались).';

-- read-only роль специалистов (есть на проде; локально может отсутствовать)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dataset_ro') THEN
    GRANT SELECT ON lead_capture_state, lookup_lead_status TO dataset_ro;
  END IF;
END $$;
