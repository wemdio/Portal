-- Suppression-список OutreachOS self-outreach: наши клиенты (AMO CRM) никогда
-- не должны получать наши холодные письма. kind='email' — точный адрес
-- (клиенты на бесплатных провайдерах); kind='domain' — корп-домен целиком
-- (любой ящик + компания по сайту). Читается каждым прогоном пайплайна.
CREATE TABLE IF NOT EXISTS outreachos_suppression (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('email', 'domain')),
  value text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);

COMMENT ON TABLE outreachos_suppression IS 'OutreachOS: клиенты/домены, исключённые из self-outreach навсегда (сид из AMO-выгрузки)';
