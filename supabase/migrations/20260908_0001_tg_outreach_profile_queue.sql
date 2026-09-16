-- Правка профиля на работающей кампании — через очередь, а не своим соединением.
--
-- Ручка профиля открывала собственное подключение к Telegram, а второе
-- подключение к той же сессии Telegram встречает AUTH_KEY_DUPLICATED и
-- выключает аккаунт. Поэтому профиль правился только на остановленной
-- кампании: чтобы настроить один аккаунт, оператор останавливал рассылку всем
-- двадцати.
--
-- Тот же вопрос уже решён дважды — у проверки аккаунта (20260827_0001) и у
-- обжалования заморозки (20260907_0002): оператор ставит заказ, а выполняет его
-- воркер тем соединением, которое и так открыто. Профиль переезжает туда же.
--
-- `profile_payload` хранит заказ целиком, включая список запасных ников. Ник
-- может освободиться и занестись между подбором и применением — минуты, а то и
-- часы, если круг длинный. Воркер проверяет варианты по порядку и ставит первый
-- свободный, а не падает на занятом первом.

alter table public.tg_outreach_accounts
  add column if not exists profile_requested_at timestamptz,
  add column if not exists profile_requested_by_name text,
  add column if not exists profile_payload jsonb,
  add column if not exists profile_status text,
  add column if not exists profile_detail text,
  add column if not exists profile_applied_at timestamptz;

comment on column public.tg_outreach_accounts.profile_requested_at is
  'Оператор заказал правку профиля на работающей кампании. Воркер применит её своим соединением в ближайшем круге и обнулит поле.';
comment on column public.tg_outreach_accounts.profile_payload is
  'Что применить: first_name, last_name, bio, username и username_candidates — запасные ники на случай, если желаемый успели занять.';
comment on column public.tg_outreach_accounts.profile_status is
  'Итог последнего применения: applied — записано в Telegram, failed — не удалось. NULL — заказов не было.';

create index if not exists tg_outreach_accounts_profile_requested_idx
  on public.tg_outreach_accounts (campaign_id)
  where profile_requested_at is not null;
