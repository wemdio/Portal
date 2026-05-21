-- Делаем authorization-схему endpoint'а конфигурируемой.
--
-- У разных клиентов может быть разный формат заголовка. Mailganer (текущий
-- интегрируемый клиент) ожидает кастомный префикс «CodeRequest»:
--   Authorization: CodeRequest <api_key>
-- Стандартный OAuth-стайл («Bearer <token>») оставляем дефолтом для всех
-- остальных интеграций.

ALTER TABLE public.client_auto_pipeline_configs
  ADD COLUMN IF NOT EXISTS endpoint_auth_scheme text NOT NULL DEFAULT 'Bearer';

COMMENT ON COLUMN public.client_auto_pipeline_configs.endpoint_auth_scheme IS
  'Префикс в Authorization-заголовке: «Bearer» (OAuth-стайл, дефолт), «CodeRequest» (Mailganer), «ApiKey» и пр. Перед значением пробел добавляется автоматически.';
