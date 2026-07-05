-- 018_portal_mirror.sql — «управленческий контур»: кураторское зеркало портальных данных
-- (проекты, периоды, КПИ-история, задачи, спецы, мост проект↔кампания, квалификации, передачи)
-- в instantly_dataset. Источники: main-postgres (144:35434) + операционная instantly-БД (144:35432).
-- Грузится ночным sync-portal-mirror.mjs (TRUNCATE+INSERT). Идемпотентно.
-- СОЗНАТЕЛЬНО НЕ зеркалим: брифы, handoff email/легенды, ссылки на договоры, финансы
-- (budget/margin/payment*), контакты сотрудников (email/phone/tg), полные тела переписки
-- (они и так в raw_emails), telegram_chat_id, вложения задач.

CREATE TABLE IF NOT EXISTS portal_projects (
  id uuid PRIMARY KEY,
  name text, client text, status text, project_type text,
  specialist text, specialist_user_id uuid, manager text,
  kpi_plan text, kpi_fact text,
  contacts_obligation text, contacts_done text, contacts_done_synced_at timestamptz,
  deadline text, launch_date text, contract_date text,
  region text, lead_source text, work_format text,
  created_at timestamptz, updated_at timestamptz
);
COMMENT ON TABLE portal_projects IS 'Зеркало projects из Портала (ночной синк). ВНИМАНИЕ: kpi_plan/kpi_fact/contacts_* /deadline и др. — TEXT свободного формата («10 встреч», «8000-16000», «-»); парсить как в UI: ведущее число. client = имя клиента (текст), manager = ПМ (текст, без FK), specialist_user_id → portal_specialists.id (бывает NULL у бот-проектов). Статусы: В работе/Тестирование/Подготовка/На паузе/Завершен (матчить ILIKE по подстроке). Типизированный КПИ — в portal_contacts_history. Готовое здоровье — v_portal_project_health.';

CREATE TABLE IF NOT EXISTS portal_project_periods (
  id uuid PRIMARY KEY,
  project_id uuid, name text, status text,
  period_start date, period_end date,
  contacts_obligation text, contacts_done text, kpi_plan text, kpi_fact text,
  deadline date, created_at timestamptz
);
COMMENT ON TABLE portal_project_periods IS 'Периоды (продления) проекта: status active|closed. projects.* зеркалит АКТИВНЫЙ период; закрытые = история продлений. При активном периоде КПИ-историю фильтровать по period_id.';

CREATE TABLE IF NOT EXISTS portal_contacts_history (
  id uuid PRIMARY KEY,
  project_id uuid, period_id uuid,
  recorded_at date, contacts_done integer, kpi_fact integer
);
COMMENT ON TABLE portal_contacts_history IS 'Ежедневные снапшоты факта: contacts_done (контакты) и kpi_fact (встречи/лиды) по проекту/периоду. ЕДИНСТВЕННЫЙ типизированный КПИ-источник — темп/тренды считать отсюда (окно ≤90 последних точек, как в UI).';

CREATE TABLE IF NOT EXISTS portal_tasks (
  id uuid PRIMARY KEY,
  project_id uuid, title text, status text, specialist text,
  deadline timestamptz, board_id uuid, column_id uuid,
  created_at timestamptz, updated_at timestamptz
);
COMMENT ON TABLE portal_tasks IS 'Задачи спецов: status pending|in_progress|done|backlog; specialist = текст-имя; «просрочена» = deadline < now() AND status<>''done'' (в БД флага нет). project_id nullable (доскоые задачи).';

CREATE TABLE IF NOT EXISTS portal_task_boards (
  id uuid PRIMARY KEY, name text, is_default boolean, position integer, created_at timestamptz
);
CREATE TABLE IF NOT EXISTS portal_task_board_columns (
  id uuid PRIMARY KEY, board_id uuid, title text, position integer, status text, created_at timestamptz
);
COMMENT ON TABLE portal_task_board_columns IS 'Колонки канбан-досок; column.status может дублировать tasks.status.';

CREATE TABLE IF NOT EXISTS portal_specialists (
  id uuid PRIMARY KEY, full_name text, role text, created_at timestamptz
);
COMMENT ON TABLE portal_specialists IS 'Люди Портала (profiles) БЕЗ контактов: id, имя, роль (client|manager|technician|admin|lead|marketer|sales). role=client — аккаунты клиентов, не спецы.';

CREATE TABLE IF NOT EXISTS portal_project_notes (
  id uuid PRIMARY KEY, project_id uuid, title text, created_at timestamptz
);

CREATE TABLE IF NOT EXISTS portal_project_campaigns (
  project_id uuid NOT NULL, campaign_id text NOT NULL,
  match_source text, match_confidence real, created_at timestamptz,
  PRIMARY KEY (project_id, campaign_id)
);
COMMENT ON TABLE portal_project_campaigns IS 'МОСТ проект↔кампания Instantly (авто-матчинг + manual), denylist УЖЕ вычтен синком. Ключ разреза «метрики кампаний по проекту»: JOIN raw_campaigns/v_campaign_health ON campaign_id. Редкие кампании замаплены на 2 проекта.';

CREATE TABLE IF NOT EXISTS portal_period_campaigns (
  project_id uuid, period_id uuid, campaign_id text,
  baseline_contacts integer, created_at timestamptz
);
COMMENT ON TABLE portal_period_campaigns IS 'Периодная версия моста: контакты периода = контакты кампании МИНУС baseline_contacts (снятые на старте периода).';

CREATE TABLE IF NOT EXISTS portal_lead_qualifications (
  id uuid PRIMARY KEY,
  campaign_id text, campaign_name text,
  lead_email text, lead_name text, company_name text,
  status text, ai_reason text, ai_confidence real,
  reply_timestamp timestamptz, read_at timestamptz, read_by uuid,
  created_at timestamptz
);
COMMENT ON TABLE portal_lead_qualifications IS 'ИИ-квалификация входящих ответов: status lead|not_lead|objection|needs_review|error; status=''lead'' = квалифицированный лид (money-метрика проекта). read_at/read_by — прочитал ли спец (SLA). Тексты ответов НЕ здесь — они в raw_emails (join по campaign_id+lead_email). Связь с проектом — через portal_project_campaigns (≈92% покрытие).';

CREATE TABLE IF NOT EXISTS portal_forwarded_leads (
  id uuid PRIMARY KEY,
  campaign_id text, campaign_name text,
  lead_email text, lead_name text, company_name text, status text,
  client_user_id uuid, forwarded_by uuid, forwarded_via text,
  reply_timestamp timestamptz, created_at timestamptz
);
-- client_email убран (аудит 06.07): через него значением протекал handoff_email проекта.
ALTER TABLE portal_forwarded_leads DROP COLUMN IF EXISTS client_email;
COMMENT ON TABLE portal_forwarded_leads IS 'Факт передачи лида клиенту (portal|email|handoff-auto). forwarded_by → portal_specialists; клиент — по client_user_id → portal_specialists (role=client). ГОЧА: project_id в источнике не заполняется, а мост покрывает ~5/63 кампаний передач — связь с проектом строить по campaign_id и относиться скептически.';

CREATE TABLE IF NOT EXISTS portal_kb_documents (
  id uuid PRIMARY KEY,
  title text, category text, description text, content_text text,
  source_type text, token_count integer, uploaded_by uuid,
  created_at timestamptz, updated_at timestamptz
);
COMMENT ON TABLE portal_kb_documents IS 'Кейсы и продуктовая информация из «Базы знаний» Портала (категории cases + product_info, только status=ready). content_text = полный текст кейса — искать ILIKE/полнотекстом. Переписки (sales_chats/client_chats) и видео-транскрипты СОЗНАТЕЛЬНО не зеркалятся. Семантический (embedding) поиск остаётся в Портале — здесь только текст.';

CREATE TABLE IF NOT EXISTS portal_mirror_meta (
  table_name text PRIMARY KEY, rows integer, synced_at timestamptz
);
COMMENT ON TABLE portal_mirror_meta IS 'Свежесть зеркала: когда и сколько строк синкнуто по каждой portal_-таблице.';

-- ── Безопасный парсер свободнотекстовых дат Портала. НЕ CASE в вьюхе: битые значения
--    (напр. US-формат '05.18.2026' — месяц 18) роняли to_date рантайм-ошибкой на ЛЮБОМ
--    запросе к вьюхе (аудит 06.07). Функция глотает исключение → NULL, US-формат чинит. ──
CREATE OR REPLACE FUNCTION portal_parse_date(t text) RETURNS date
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE a int; b int;
BEGIN
  IF t IS NULL OR btrim(t) = '' THEN RETURN NULL; END IF;
  IF t ~ '^\s*\d{4}-\d{2}-\d{2}' THEN
    RETURN substring(t FROM '\d{4}-\d{2}-\d{2}')::date;
  END IF;
  IF t ~ '^\s*\d{1,2}\.\d{1,2}\.\d{4}' THEN
    a := split_part(substring(t FROM '\d{1,2}\.\d{1,2}\.\d{4}'), '.', 1)::int;
    b := split_part(substring(t FROM '\d{1,2}\.\d{1,2}\.\d{4}'), '.', 2)::int;
    IF b BETWEEN 1 AND 12 THEN
      RETURN to_date(substring(t FROM '\d{1,2}\.\d{1,2}\.\d{4}'), 'DD.MM.YYYY');
    ELSIF a BETWEEN 1 AND 12 THEN  -- US-формат MM.DD.YYYY ('05.18.2026')
      RETURN to_date(substring(t FROM '\d{1,2}\.\d{1,2}\.\d{4}'), 'MM.DD.YYYY');
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

-- ── Вьюха темпа: воспроизводит computePace из UI (окно = последние ≤90 снапшотов;
--    при активном периоде история изолируется по period_id; avgPerDay дробный) ──
CREATE OR REPLACE VIEW v_portal_project_pace AS
WITH scope AS (
  SELECT p.id AS project_id,
         (SELECT pp.id FROM portal_project_periods pp
           WHERE pp.project_id = p.id AND pp.status = 'active'
           ORDER BY pp.created_at DESC LIMIT 1) AS active_period_id
  FROM portal_projects p
),
hist AS (
  SELECT s.project_id, h.recorded_at, h.contacts_done, h.kpi_fact,
         row_number() OVER (PARTITION BY s.project_id ORDER BY h.recorded_at DESC) AS rn
  FROM scope s
  JOIN portal_contacts_history h
    ON h.project_id = s.project_id
   AND (s.active_period_id IS NULL OR h.period_id = s.active_period_id)
),
win AS (SELECT * FROM hist WHERE rn <= 90),
agg AS (
  SELECT project_id,
         count(*) AS points,
         max(recorded_at) FILTER (WHERE rn = 1) AS last_date,
         min(recorded_at) AS first_date,
         max(contacts_done) FILTER (WHERE rn = 1) AS last_contacts,
         (array_agg(contacts_done ORDER BY recorded_at ASC))[1] AS first_contacts,
         max(kpi_fact) FILTER (WHERE rn = 1) AS last_kpi,
         (array_agg(kpi_fact ORDER BY recorded_at ASC))[1] AS first_kpi
  FROM win GROUP BY project_id
)
SELECT project_id, points, first_date, last_date,
       last_contacts, last_kpi,
       CASE WHEN points >= 2 THEN
         (last_contacts - first_contacts)::numeric / GREATEST(1, (last_date - first_date)) END AS contacts_per_day,
       CASE WHEN points >= 2 THEN
         (last_kpi - first_kpi)::numeric / GREATEST(1, (last_date - first_date)) END AS kpi_per_day
FROM agg;
COMMENT ON VIEW v_portal_project_pace IS 'Темп проекта из КПИ-истории (формула UI computePace): дельта за окно ≤90 последних снапшотов / дни; при активном периоде — только его снапшоты. points<2 → темп NULL (мало данных).';

-- ── Главная управленческая вьюха: проект + план/факт + темп + флаги проблемности +
--    лиды/передачи/задачи. Формулы «проблемности» = isProblemProject из UI. ──
CREATE OR REPLACE VIEW v_portal_project_health AS
WITH parsed AS (
  SELECT p.*,
    COALESCE(NULLIF(substring(p.contacts_obligation FROM '^\s*(\d+)'), '')::bigint, 0) AS plan_contacts,
    COALESCE(NULLIF(substring(p.contacts_done       FROM '^\s*(\d+)'), '')::bigint, 0) AS fact_contacts,
    COALESCE(NULLIF(substring(p.kpi_plan            FROM '^\s*(\d+)'), '')::bigint, 0) AS plan_kpi,
    COALESCE(NULLIF(substring(p.kpi_fact            FROM '^\s*(\d+)'), '')::bigint, 0) AS fact_kpi,
    portal_parse_date(p.deadline) AS deadline_date,
    p.status ILIKE '%заверш%' OR p.status ILIKE '%отмен%' AS is_completed
  FROM portal_projects p
)
SELECT
  pr.id AS project_id, pr.client, pr.name, pr.status, pr.specialist, pr.manager, pr.work_format,
  pr.plan_contacts, pr.fact_contacts, pr.plan_kpi, pr.fact_kpi,
  pr.deadline_date, (pr.deadline_date - current_date) AS days_until_deadline,
  pc.points AS pace_points, round(pc.contacts_per_day, 2) AS contacts_per_day, round(pc.kpi_per_day, 2) AS kpi_per_day,
  GREATEST(0, pr.plan_contacts - pr.fact_contacts) AS remaining_contacts,
  GREATEST(0, pr.plan_kpi - pr.fact_kpi) AS remaining_kpi,
  CASE WHEN pr.plan_contacts > 0 AND pc.contacts_per_day > 0
       THEN ceil(GREATEST(0, pr.plan_contacts - pr.fact_contacts) / pc.contacts_per_day) END AS forecast_days_contacts,
  CASE WHEN pr.plan_kpi > 0 AND pc.kpi_per_day > 0
       THEN ceil(GREATEST(0, pr.plan_kpi - pr.fact_kpi) / pc.kpi_per_day) END AS forecast_days_kpi,
  ql.leads_total, ql.leads_30d, fw.forwarded_total,
  tk.tasks_open, tk.tasks_overdue,
  pr.is_completed,
  -- флаги проблемности (как isProblemProject в UI)
  (NOT pr.is_completed AND pr.deadline_date IS NOT NULL AND pr.deadline_date < current_date
     AND ((pr.plan_contacts > 0 AND pr.fact_contacts < pr.plan_contacts)
       OR (pr.plan_kpi > 0 AND pr.fact_kpi < pr.plan_kpi)))                          AS flag_deadline_failed,
  (NOT pr.is_completed AND pr.deadline_date >= current_date AND pc.points >= 2 AND (
     (pr.plan_contacts > 0 AND pc.contacts_per_day > 0
        AND ceil(GREATEST(0, pr.plan_contacts - pr.fact_contacts) / pc.contacts_per_day) > (pr.deadline_date - current_date))
  OR (pr.plan_kpi > 0 AND pc.kpi_per_day > 0
        AND ceil(GREATEST(0, pr.plan_kpi - pr.fact_kpi) / pc.kpi_per_day) > (pr.deadline_date - current_date)) )) AS flag_behind_pace,
  (NOT pr.is_completed AND pr.deadline_date IS NOT NULL
     AND (pr.deadline_date - current_date) BETWEEN 0 AND 14 AND (
     (pr.plan_contacts > 0 AND pr.fact_contacts < pr.plan_contacts AND COALESCE(pc.contacts_per_day, 0) <= 0)
  OR (pr.plan_kpi > 0 AND pr.fact_kpi < pr.plan_kpi AND COALESCE(pc.kpi_per_day, 0) <= 0) ))     AS flag_zero_pace_near_deadline
FROM parsed pr
LEFT JOIN v_portal_project_pace pc ON pc.project_id = pr.id
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE q.status = 'lead') AS leads_total,
         count(*) FILTER (WHERE q.status = 'lead' AND q.created_at > now() - interval '30 days') AS leads_30d
  FROM portal_project_campaigns b JOIN portal_lead_qualifications q ON q.campaign_id = b.campaign_id
  WHERE b.project_id = pr.id
) ql ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS forwarded_total
  FROM portal_project_campaigns b JOIN portal_forwarded_leads f ON f.campaign_id = b.campaign_id
  WHERE b.project_id = pr.id
) fw ON true
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE t.status <> 'done') AS tasks_open,
         count(*) FILTER (WHERE t.status <> 'done' AND t.deadline < now()) AS tasks_overdue
  FROM portal_tasks t WHERE t.project_id = pr.id
) tk ON true;
COMMENT ON VIEW v_portal_project_health IS 'Управленческий контур: план/факт (ведущее число из text-полей — как parseInt в UI), темп, прогноз, квал.лиды (через мост, ~92% покрытие), передачи (~покрытие моста низкое — скептически), задачи, флаги проблемности (= isProblemProject UI: провален дедлайн / отстаёт по темпу / нулевой темп ≤14 дн до дедлайна). «Проблемный» = не завершён, есть план и любой флаг TRUE. Деньги/финансы сознательно не зеркалятся.';

-- read-only роль специалистов видит всё зеркало
GRANT SELECT ON portal_projects, portal_project_periods, portal_contacts_history,
  portal_tasks, portal_task_boards, portal_task_board_columns, portal_specialists,
  portal_project_notes, portal_project_campaigns, portal_period_campaigns,
  portal_lead_qualifications, portal_forwarded_leads, portal_kb_documents,
  portal_mirror_meta, v_portal_project_pace, v_portal_project_health TO dataset_ro;
