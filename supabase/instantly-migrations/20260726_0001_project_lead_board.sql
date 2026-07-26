-- Гостевая таблица лидов проекта (lead board): постоянная публичная ссылка
-- (/leads-board/<token>) на страницу со ВСЕМИ квалифицированными лидами проекта.
-- Ссылка печатается в TG-карточке лида у спецов и пересылается клиенту.
--
-- project_lead_boards  — по проекту: capability-токен + конфиг видимости колонок.
--   Токен хранится ЦЕЛИКОМ (не хэш): ссылку надо рендерить в каждом алерте
--   заново, а сама ссылка — это и есть credential (capability URL). Отзыв —
--   регенерация токена (старые ссылки умирают).
-- project_lead_board_rows — по одному ряду на квалификацию (status='lead',
--   project-linked кампания). Авто-колонки пишет воркер (leadBoardWriter),
--   клиентские (quality/comment/taken) — публичный API по токену.
--
-- Оба project_id — soft-ссылки на main-БД projects.id (как
-- client_forwarded_leads.project_id в 20260420_0001), FK через БД нет.
CREATE TABLE IF NOT EXISTS public.project_lead_boards (
  project_id uuid PRIMARY KEY,
  token text NOT NULL,
  column_config jsonb NOT NULL DEFAULT '[
    {"key":"phone","visible":true},
    {"key":"email","visible":true},
    {"key":"name","visible":true},
    {"key":"company","visible":true},
    {"key":"website","visible":true},
    {"key":"request","visible":true},
    {"key":"quality","visible":true},
    {"key":"comment","visible":true},
    {"key":"campaign","visible":true},
    {"key":"step","visible":true},
    {"key":"date","visible":true},
    {"key":"taken","visible":true}
  ]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS project_lead_boards_token_idx
  ON public.project_lead_boards (token);

CREATE TABLE IF NOT EXISTS public.project_lead_board_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  qualification_id uuid UNIQUE,
  -- авто-колонки (воркер, read-only для гостя)
  lead_email text,
  lead_name text,
  company_name text,
  phone text,
  website text,
  request_text text,
  campaign_id text,
  campaign_name text,
  step_number integer,
  reply_timestamp timestamptz,
  -- клиентские колонки (правятся через публичный API по токену)
  quality text,
  comment text,
  taken boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_lead_board_rows_project_ts_idx
  ON public.project_lead_board_rows (project_id, reply_timestamp DESC);

ALTER TABLE public.project_lead_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_lead_board_rows ENABLE ROW LEVEL SECURITY;

-- Доступ только service-уровню: публичный API проверяет токен сам и ходит
-- service-клиентом (паттерн database-review guest API).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.project_lead_boards to service_role;
    grant all on public.project_lead_board_rows to service_role;
  end if;

  if exists (select 1 from pg_roles where rolname = 'instantly') then
    grant all on public.project_lead_boards to instantly;
    grant all on public.project_lead_board_rows to instantly;
  end if;
end $$;

DROP POLICY IF EXISTS "Service role full access on project_lead_boards" ON public.project_lead_boards;
DROP POLICY IF EXISTS "Service role full access on project_lead_board_rows" ON public.project_lead_board_rows;
CREATE POLICY "Service role full access on project_lead_boards"
  ON public.project_lead_boards FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access on project_lead_board_rows"
  ON public.project_lead_board_rows FOR ALL USING (true) WITH CHECK (true);
