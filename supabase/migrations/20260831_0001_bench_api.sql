-- Bench API — внешняя витрина инструментов (парсеры, конструктор баз, поиск
-- по собранным базам) для подрядчиков, пишущих свои скрипты поверх портала.
--
-- Зачем таблицы. До сих пор единственный внешний ключ портала (партнёрская
-- выгрузка активности) лежал в переменной окружения: один ключ на всех,
-- отозвать — только деплоем, и не видно, кто чем пользовался. Для подрядчика
-- этого мало: ключей нужно несколько, отзыв нужен мгновенный, и нужно знать,
-- что именно дёргали.
--
-- Как устроена изоляция. Ключ привязан к учётке-роботу; задачи, поставленные
-- по ключу, принадлежат ей. Дальше работает то, что уже есть: у всех таблиц
-- задач есть владелец, а у таблиц результатов — политики RLS, отдающие строки
-- только владельцу родительской задачи. Витрина ходит в базу от имени робота,
-- поэтому чужое не отдаст сама база, а не наш код. Отдельного движка прав не
-- строим намеренно — он был бы вторым, расходящимся с первым источником правды.

-- Учётка-робот. Пароля у неё нет, роли тоже — внутрь портала такая учётка не
-- проходит (middleware отбивает аккаунты без роли). Флаг нужен, чтобы админка
-- не показывала роботов в списке людей: иначе через полгода никто не вспомнит,
-- что это за «пользователи» без ролей и можно ли их удалять.
alter table public.profiles
  add column if not exists is_api_robot boolean not null default false;

comment on column public.profiles.is_api_robot is
  'Учётка-робот внешнего Bench API. Без пароля и роли, в списке пользователей не показывается.';

create table if not exists public.bench_api_keys (
  id uuid primary key default gen_random_uuid(),

  -- Кому выдан: человеческое имя для админки («Дима», «Сергей — тест»).
  name text not null,

  -- Хранится ОТПЕЧАТОК (sha256 hex), а не ключ. Даже с полным доступом к базе
  -- ключ не восстановить; показывается он ровно один раз при выдаче.
  -- unique — потому что проверка ключа это точечный поиск по этому столбцу.
  key_hash text not null unique,

  -- Последние 4 символа — чтобы человек в админке узнал свой ключ среди
  -- нескольких, не имея самого ключа.
  key_last4 text not null,

  -- on delete restrict, а не cascade: удаление робота, у которого есть живой
  -- ключ, — это почти наверняка ошибка. Сначала отзови ключ, потом удаляй.
  robot_user_id uuid not null references public.profiles(id) on delete restrict,

  -- Инструмента нет в списке — его для этого ключа не существует. Пустой
  -- массив означает «ничего не разрешено», а не «разрешено всё».
  allowed_tools text[] not null default '{}',

  -- Четыре потолка. Запуск парсера — это общий пул прокси и оплаченные токены
  -- LLM, поэтому объём ограничивается на входе, а не разбирается постфактум.
  rpm_limit integer not null default 60,
  daily_jobs_limit integer not null default 50,
  daily_rows_limit integer not null default 200000,
  -- Параллельность воркеров общая на всех: десяток задач робота отодвинул бы
  -- живых сотрудников в очереди.
  max_active_jobs integer not null default 3,

  -- Отзыв — проставление даты, а не удаление строки: журнал обращений должен
  -- пережить отзыв, иначе после инцидента нечего будет разбирать.
  revoked_at timestamptz,

  last_used_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.bench_api_keys is
  'Ключи Bench API. Хранится отпечаток ключа (sha256 hex), не сам ключ.';

create table if not exists public.bench_api_requests (
  id bigserial primary key,
  key_id uuid not null references public.bench_api_keys(id) on delete cascade,
  tool text,
  action text not null,
  status_code integer not null,
  -- Сколько строк отдали. По этому столбцу считается суточная норма строк —
  -- главный ограничитель постепенной выкачки наших баз.
  rows_returned integer not null default 0,
  duration_ms integer not null default 0,
  created_at timestamptz not null default now()
);

-- Тела запросов здесь не пишутся намеренно: в них приходят базы клиентов, и
-- журнал превратился бы в копилку чужих персональных данных без всякой нужды.
comment on table public.bench_api_requests is
  'Журнал обращений к Bench API: только метаданные, без тел запросов.';

-- Все лимиты — оконные запросы вида «сколько было за минуту / за сутки»,
-- поэтому индексы идут по (ключ, время) и (ключ, действие, время).
create index if not exists idx_bench_api_requests_key_created
  on public.bench_api_requests (key_id, created_at desc);

create index if not exists idx_bench_api_requests_key_action_created
  on public.bench_api_requests (key_id, action, created_at desc);

-- Обе таблицы служебные: к ним ходит только сервисная роль из кода витрины и
-- админки. RLS включаем БЕЗ политик — то есть обычный пользовательский токен
-- (в том числе токен робота) не видит их вовсе. Это важно: иначе робот мог бы
-- прочитать отпечатки и лимиты собственного и чужих ключей.
alter table public.bench_api_keys enable row level security;
alter table public.bench_api_requests enable row level security;

-- Права. Сервисной роли — всё: ею работают проверка ключа (lib/bench/auth.ts),
-- журнал (lib/bench/journal.ts), подсчёт лимитов и будущий экран админки.
grant all on public.bench_api_keys to service_role;
grant all on public.bench_api_requests to service_role;
grant usage, select on sequence public.bench_api_requests_id_seq to service_role;

-- Роли authenticated — НИЧЕГО, и это главное здесь.
--
-- Витрина ходит в данные задач от имени учётки-робота, а у робота роль
-- ровно authenticated. Выдай мы ему select на эти таблицы — он прочитал бы
-- отпечатки и лимиты и своего, и чужих ключей. RLS без политик его уже
-- отсекает, но отсутствие гранта закрывает тот же путь вторым, независимым
-- способом: политику можно случайно добавить, грант — нет.
