-- BYO mailbox: разрешаем auth_type='oauth_yandex' (подключение Яндекс.Почты по OAuth).
alter table public.client_mailbox_accounts
  drop constraint if exists client_mailbox_accounts_auth_type_check;
alter table public.client_mailbox_accounts
  add constraint client_mailbox_accounts_auth_type_check
  check (auth_type in ('password', 'oauth_google', 'oauth_microsoft', 'oauth_yandex'));
