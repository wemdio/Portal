-- Связь подключённого клиентского ящика с отправляющим аккаунтом в Instantly.
--
-- Зачем. До сих пор ENG-кампании уходили с НАШИХ ящиков в общем воркспейсе —
-- это блокер выпуска: репутация клиентов смешивается. Клиент подключает свои
-- ящики в кабинете (contour byoMailbox уже умеет проверять SMTP и шифровать
-- пароль), а отправка остаётся на Instantly. Здесь хранится состояние второго
-- шага: заведён ли ящик у отправляющего провайдера и что с ним.
--
-- Клиент про Instantly не знает: в интерфейсе это «sending», без имени
-- провайдера. Имя колонок внутреннее.

alter table public.client_mailbox_accounts
  -- В каком аккаунте провайдера заведён ящик (INSTANTLY_ACCOUNTS_JSON.id).
  -- Сейчас он один, но мультиаккаунтность в коде уже есть — не закладываемся
  -- на единственный.
  add column if not exists instantly_account_id text,
  -- Состояние регистрации у провайдера, отдельно от состояния SMTP-проверки:
  --   not_registered — ящик сохранён у нас, но провайдеру не отдан;
  --   registered     — заведён, готов к отправке;
  --   failed         — провайдер отказал (см. instantly_error);
  --   removed        — снят у провайдера (отключение клиента, ротация пароля).
  add column if not exists instantly_status text not null default 'not_registered',
  add column if not exists instantly_registered_at timestamptz,
  add column if not exists instantly_error text,
  -- Последняя проверка живости ящика у провайдера (testAccountVitals).
  -- Пароль приложения Google отзывается при смене пароля пользователя, и
  -- отправка встаёт МОЛЧА — поэтому живость проверяется ночью, а не по факту
  -- жалобы клиента.
  add column if not exists instantly_checked_at timestamptz,
  add column if not exists instantly_vitals text;

alter table public.client_mailbox_accounts
  drop constraint if exists client_mailbox_accounts_instantly_status_chk;
alter table public.client_mailbox_accounts
  add constraint client_mailbox_accounts_instantly_status_chk
  check (instantly_status in ('not_registered', 'registered', 'failed', 'removed'));

-- Ночной health-check ходит по зарегистрированным ящикам, начиная с самых
-- давно не проверенных.
create index if not exists idx_client_mailbox_instantly_check
  on public.client_mailbox_accounts (instantly_status, instantly_checked_at)
  where instantly_status = 'registered';

comment on column public.client_mailbox_accounts.instantly_status is
  'Состояние ящика у отправляющего провайдера: not_registered/registered/failed/removed';
comment on column public.client_mailbox_accounts.instantly_vitals is
  'Итог последней проверки живости у провайдера; ошибка означает, что пароль приложения отозван или доступ закрыт';
