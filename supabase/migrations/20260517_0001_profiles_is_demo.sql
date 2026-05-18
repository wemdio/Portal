-- Демо-аккаунт: read-only клиентский портал с фикстурными данными,
-- выдаётся потенциальным клиентам «посмотреть начинку».
--
-- Флаг is_demo на profiles. requireClientAuth по нему:
--   1) режет все мутирующие запросы демо-юзера (строго read-only);
--   2) клиентские GET-роуты отдают фикстуры вместо реальных данных,
--      Instantly API при демо-входе не дёргается вообще.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.is_demo IS
  'Demo account: read-only client portal served fixture data (lib/clientDemo), shared with prospects.';
