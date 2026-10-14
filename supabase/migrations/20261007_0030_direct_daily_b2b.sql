-- Ежедневный сбор рекламодателей Яндекс Директа по B2B-библиотеке ключей
-- (app/src/lib/parsers/yandexDirect/dailyB2b.ts, решение 07.10.2026).
--
-- Воркер hh раз в сутки (с 01:00 МСК) сам создаёт обычную задачу
-- yandex_direct_jobs со следующим отрезком библиотеки. Отдельной таблицы
-- состояния нет: отрезок продолжает ключи последней удачной ежедневной задачи.

-- День МСК ежедневной задачи; у ручных задач — null.
alter table public.yandex_direct_jobs
  add column if not exists daily_day date;

comment on column public.yandex_direct_jobs.daily_day is
  'День МСК ежедневного B2B-сбора (воркер hh). У ручных задач — null.';

-- Не больше одной ежедневной задачи на день (гонка двух воркеров).
create unique index if not exists uniq_yandex_direct_jobs_daily_day
  on public.yandex_direct_jobs(daily_day)
  where daily_day is not null;

-- «Один активный job на пользователя» — теперь только для ручных задач:
-- ночная задача записана на владельца автодобора и не должна блокировать
-- его ручной запуск с экрана парсера (и наоборот). Очередь XMLStock всё
-- равно одна — воркер берёт задачи Директа строго по одной.
drop index if exists public.uniq_yandex_direct_jobs_active_per_user;
create unique index if not exists uniq_yandex_direct_jobs_active_per_user
  on public.yandex_direct_jobs(user_id)
  where status in ('pending', 'processing') and daily_day is null;
