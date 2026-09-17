-- Ящики Google Workspace без паролей: вход по временному ключу.
--
-- Пароль приложения Google создаёт только сам владелец ящика, зайдя в аккаунт.
-- На двух сотнях аутрич-ящиков это двести заходов руками, поэтому появился
-- второй способ входа: служебный аккаунт с делегированием на домен. Админ
-- Workspace один раз разрешает его, после чего портал получает у Google
-- короткоживущий ключ на нужный ящик и входит по SMTP/IMAP с ним. Пароля у
-- такого ящика нет вовсе — хранить нечего.
alter table public.sender_mailboxes
  add column if not exists auth_type text not null default 'password';

alter table public.sender_mailboxes
  drop constraint if exists sender_mailboxes_auth_type_check;

alter table public.sender_mailboxes
  add constraint sender_mailboxes_auth_type_check
  check (auth_type in ('password', 'google_sa'));

-- Ящик с входом по ключу приходит без секрета, а колонка была обязательной.
alter table public.sender_mailboxes
  alter column secret_encrypted drop not null;

comment on column public.sender_mailboxes.auth_type is
  'password — пароль приложения из выгрузки провайдера; google_sa — служебный аккаунт Google с делегированием на домен, секрет не хранится.';
