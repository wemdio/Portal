-- ENG («Движок вертикалей», self-serve кабинет app.outreachos.xyz): отметка
-- блокировки аккаунта клиента.
--
-- ЗАЧЕМ. Решение владельца 12.10.2026: «если бан, то всё нужно останавливать и
-- блокировать». Бан входа (GoTrue banned_until) без этой отметки держит только
-- НОВОЕ: вход, новые платные шаги (кабинет, дочейн автопилота), ночной добор,
-- автозапуск и письма клиенту — эти пути читают и banned_until. Уже идущее
-- бан не останавливает: кампании у рассыльщика отправляют, джобы, уже
-- стоящие в очереди воркера, дорабатывают (страж джобы читает только эту
-- отметку), а выключатель отправки и «Daily top-up» остаются, какими были.
-- Поэтому блокировка ENG-клиента в админке («Английские клиенты» →
-- «Заблокировать») первым шагом пишет эту отметку и останавливает идущее, а
-- фоновые пути читают отметку перед работой: клейм джобы
-- воркером, письма клиенту, автозапуск, гейт платных шагов, ночной добор,
-- включение отправки сотрудником, сброс пароля, фоновая проверка кампаний
-- заблокированных. Чтение отметки — один запрос по первичному ключу, без
-- GoTrue. Код — app/src/lib/hypothesisEngine/engAccountBlockMarker.ts.
--
-- ЧТО ЗДЕСЬ. he_eng_account_blocks — строка на аккаунт (profiles.id), который
-- хоть раз блокировали:
--   user_id               — аккаунт. БЕЗ внешнего ключа на profiles: отметка
--                           переживает удалённый профиль (его us-проекты, у
--                           которых created_by тоже без FK, остаются);
--   active                — блокировка действует (true) или снята (false);
--   blocked_at            — первое нажатие «Заблокировать» ТЕКУЩЕГО эпизода
--                           (у бана без отметки эпизод открывает
--                           «Разблокировать»: до снятия бана оно делает ту же
--                           остановку с отметкой); повторное нажатие его не
--                           двигает;
--   last_block_at         — последнее нажатие (повтор доставляет остановку
--                           ещё раз);
--   blocked_by            — сотрудник последнего нажатия (profiles.id, без FK);
--   unblocked_at / unblocked_by — снятие блокировки; у снятой отметки
--                           (active = false) unblocked_at обязателен (проверка
--                           ниже), новый эпизод блокировки их стирает;
--   sending_before        — выключатель отправки аккаунта при ПЕРВОМ нажатии
--                           эпизода: 'enabled' — включена, 'waiting' — клиент
--                           ждал включения, 'not_enabled' — не включали,
--                           'revoked' — уже выключена, 'not_required' —
--                           требование включения снято переменной окружения,
--                           'unknown' — не прочитался. Карточка клиента и отчёт
--                           разблокировки называют его сотруднику: разблокировка
--                           возвращает только вход, отправку включает человек;
--   refill_enabled_before — переключатель «Daily top-up» каждого us-проекта
--                           при первом нажатии эпизода: объект
--                           { "<project_id>": "on" | "off" | "no_config" |
--                           "unknown" }; null — не прочитан. Блокировка этот
--                           переключатель выключает (иначе после включения
--                           отправки ночной добор сам продолжил бы завершённую
--                           основную кампанию), а включает его обратно сам
--                           клиент — отчёт разблокировки называет, у кого он
--                           был включён;
--   last_stop             — отчёт последней блокировки (что остановилось, что
--                           нет) — его показывает карточка клиента;
--   updated_at            — последняя запись строки.
--
-- КАК ПИШЕТСЯ. Повтор нажатия — условный UPDATE по active = true: двигает
-- last_block_at / blocked_by, а blocked_at, sending_before и
-- refill_enabled_before остаются от первого нажатия. Новый эпизод — условный
-- UPDATE по active = false либо INSERT; гонка двух первых нажатий ловится
-- уникальностью user_id (второе нажатие становится повтором). Снятие —
-- условный UPDATE по active = true.
--
-- КОД ДО МИГРАЦИИ. Таблицы нет (42P01 / PGRST205) — чтения отвечают
-- 'missing': фоновые пути работают как до блокировки (одно предупреждение в лог
-- на процесс), а «Заблокировать» пишет в отчёте красную строку «таблица не
-- создана» — вход, отправка, пауза кампаний, остановка проекта и «Daily
-- top-up» при этом всё равно выполняются; состояния «до» тогда есть только в
-- журнале действий (admin.users.block.eng_stop).
--
-- ПРАВА. Только service_role (роуты Next и воркеры); anon / authenticated /
-- public отозваны поимённо (линт app/tests/migrations/grants.test.ts). RLS
-- включён без политик.
--
-- ПОРЯДОК ВЫКАТА: миграция ДО кода S3b (без неё фоновые пути блокировку не
-- видят). Идемпотентна: if not exists, повторяемые revoke / grant / comment.
-- Раннер миграций применяет файл одной транзакцией.

create table if not exists public.he_eng_account_blocks (
  user_id               uuid primary key,
  active                boolean not null default true,
  blocked_at            timestamptz not null default now(),
  last_block_at         timestamptz not null default now(),
  blocked_by            uuid,
  unblocked_at          timestamptz,
  unblocked_by          uuid,
  sending_before        text not null default 'unknown'
                        check (sending_before in (
                          'enabled', 'not_enabled', 'waiting', 'revoked', 'not_required', 'unknown'
                        )),
  refill_enabled_before jsonb
                        check (refill_enabled_before is null or jsonb_typeof(refill_enabled_before) = 'object'),
  last_stop             jsonb
                        check (last_stop is null or jsonb_typeof(last_stop) = 'object'),
  updated_at            timestamptz not null default now(),
  constraint he_eng_account_blocks_unblock_shape check (active or unblocked_at is not null)
);

comment on table public.he_eng_account_blocks is
  'ENG: блокировка аккаунта клиента сотрудником (раздел «Английские клиенты»). active=true — фоновые пути (воркер, письма, автозапуск, платные шаги, ночной добор) работу аккаунта не делают; last_stop — отчёт последней остановки (engAccountBlockMarker.ts).';

alter table public.he_eng_account_blocks enable row level security;

revoke all privileges on table public.he_eng_account_blocks from public, anon, authenticated;
grant all on table public.he_eng_account_blocks to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_eng_account_blocks to readonly';
  end if;
end $$;
