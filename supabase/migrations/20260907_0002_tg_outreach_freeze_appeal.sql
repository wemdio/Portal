-- Обжалование заморозки: ссылка от Telegram и очередь на отправку.
--
-- Заморозку Telegram снимает не по таймеру, а по обращению — в отличие от
-- спам-блока, который проходит сам. Обращение подаётся из аккаунта, а зайти в
-- него оператор не может: телефон остался у продавца, на руках только сессия в
-- портале. 07.09.2026 в ATOL-1 так встали тринадцать аккаунтов из двадцати
-- восьми, и снять заморозку было нечем.
--
-- Подавать обращение будет сам портал — тем соединением, которое воркер уже
-- держит. Отдельно подключиться нельзя: второе подключение к той же сессии
-- Telegram встречает AUTH_KEY_DUPLICATED и выключает аккаунт (см. миграцию
-- 20260827_0001, там же и очередь проверок устроена так же).
--
-- `freeze_appeal_url` — то, что Telegram отдал в конфиге приложения: адрес, по
-- которому он сам предлагает обжаловать. Храним дословно, без разбора: формат
-- Telegram меняет свободно, а решение «можно ли туда написать» принимает код в
-- момент отправки.

alter table public.tg_outreach_accounts
  add column if not exists freeze_appeal_url text,
  -- Оператор нажал «Обжаловать»: воркер отправит обращение в ближайшем круге.
  add column if not exists appeal_requested_at timestamptz,
  add column if not exists appeal_requested_by_name text,
  -- Текст обращения оператор пишет сам: это письмо живому человеку в поддержке,
  -- и шаблон на все случаи тут был бы хуже отсутствия кнопки.
  add column if not exists appeal_text text,
  -- Итог последней попытки: ушло, или почему не ушло.
  add column if not exists appeal_status text,
  add column if not exists appeal_detail text,
  add column if not exists appealed_at timestamptz;

comment on column public.tg_outreach_accounts.freeze_appeal_url is
  'Адрес обжалования, который Telegram отдал в конфиге приложения для этого аккаунта. Заполняет проверка аккаунта.';
comment on column public.tg_outreach_accounts.appeal_requested_at is
  'Оператор заказал обжалование. Воркер отправит его своим соединением в ближайшем круге и обнулит поле.';
comment on column public.tg_outreach_accounts.appeal_status is
  'Итог последней отправки обжалования: sent — ушло, failed — не удалось. NULL — не отправляли.';

-- Воркер спрашивает «есть ли заказы по этой кампании» каждый круг.
create index if not exists tg_outreach_accounts_appeal_requested_idx
  on public.tg_outreach_accounts (campaign_id)
  where appeal_requested_at is not null;
