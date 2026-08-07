-- OutreachOS: второй источник работодателей (SuperJob).
-- Выключен по умолчанию; ключ — env SUPERJOB_APP_KEY на воркере (не в БД).
-- Каталоги SJ: IT=33, пром/производство=327, стройка=306, логистика=86,
-- маркетинг=234, HR=76, консалтинг=426.

alter table public.outreachos_pipeline_config
  add column if not exists superjob_enabled boolean not null default false,
  add column if not exists superjob_catalogues integer[] not null default '{33,327,306,86,234,76,426}';
