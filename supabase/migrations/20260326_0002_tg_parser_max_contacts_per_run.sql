-- TG parser: лимит «макс. уникальных контактов за один запуск» на аккаунт (вместо дневной квоты в UI)
alter table public.tg_parser_accounts
  add column if not exists max_contacts_per_run integer not null default 500;

comment on column public.tg_parser_accounts.max_contacts_per_run is
  'Максимум уникальных контактов за один запуск парсинга для этого аккаунта';
