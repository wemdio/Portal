-- TG parser: default daily_limit 500 (was 30); new accounts without explicit limit get 500
alter table public.tg_parser_accounts
  alter column daily_limit set default 500;
