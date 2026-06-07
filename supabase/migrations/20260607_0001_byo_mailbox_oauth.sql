-- BYO mailbox: подключение через OAuth (Google) в дополнение к app-password.
--   auth_type='password'     — SMTP по app-password (secret_encrypted.smtpPassword)
--   auth_type='oauth_google' — Gmail SMTP по OAuth2 (secret_encrypted.oauthRefreshToken)
-- Идемпотентно: колонка добавляется if not exists, constraint пересоздаётся.

alter table public.client_mailbox_accounts
  add column if not exists auth_type text not null default 'password';

alter table public.client_mailbox_accounts
  drop constraint if exists client_mailbox_accounts_auth_type_check;
alter table public.client_mailbox_accounts
  add constraint client_mailbox_accounts_auth_type_check
  check (auth_type in ('password', 'oauth_google', 'oauth_microsoft'));

comment on column public.client_mailbox_accounts.auth_type is
  'password = SMTP app-password; oauth_google = Gmail SMTP via OAuth2 refresh token (secret_encrypted.oauthRefreshToken).';
