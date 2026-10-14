-- Проверка ников базы TG-аутрича по публичной странице t.me — до того, как их
-- возьмёт аккаунт.
--
-- На «юзернейм не найден» Telegram отвечает одинаково, когда ника нет вовсе и
-- когда наш аккаунт заморожен и не видит живых людей. По ответу аккаунта их не
-- различить. 24–28.09.2026 четыре несуществующих ника в хвосте базы ATOL-1
-- отправили на суточную паузу все 50 аккаунтов кампании как «замороженные»:
-- каждый брал те же четыре ника, не находил и уходил на паузу.
--
-- Страница t.me/<ник> отвечает про ник без наших аккаунтов, поэтому фоновая
-- проверка в воркере проходит по свежим базам сразу после загрузки: ника нет —
-- контакт уходит в skipped с причиной и до аккаунтов не доходит.
--
-- username_checked_at — когда проверяли в последний раз;
-- username_exists — итог: true — ник есть, false — нет (контакт уже skipped),
-- null — t.me не ответил внятно, проверка повторится через час.

alter table public.tg_outreach_base_contacts
  add column if not exists username_checked_at timestamptz,
  add column if not exists username_exists boolean;

comment on column public.tg_outreach_base_contacts.username_checked_at is
  'Когда ник проверяли по публичной странице t.me (фоновая проверка воркера tg-outreach). null — ещё не проверяли.';

comment on column public.tg_outreach_base_contacts.username_exists is
  'Итог проверки ника по t.me: true — есть в Telegram, false — нет (контакт переведён в skipped), null — t.me не ответил внятно, повторим позже.';
