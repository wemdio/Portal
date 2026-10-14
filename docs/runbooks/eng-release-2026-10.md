# Выкат английского кабинета (ENG), октябрь 2026

Для владельца и дежурного сотрудника. Английский кабинет — самообслуживание на `app.outreachos.xyz`: движок гипотез V1, рынок `us`, клиент запускает всё сам, без проверки сотрудником.

Основа документа — сквозной аудит ENG от 14.10.2026. Его вердикт: «выкатывать можно после правок». Ниже его список правок и чек-лист выката, сверенные с кодом ветки `Sergey` на `a6b2b1a7b`.

> **Правила.**
> - Без разрешения можно только читать: `SELECT` внутри `begin read only`, `docker logs`, `docker inspect`, `crontab -l`, `free -m`, `cat`/`grep` по файлам.
> - Всё остальное делается только после явного «да» владельца, полученного прямо перед действием. Сюда входят запись в БД, правка `.env` или crontab, пересоздание контейнера, слияние в `test`/`main`, «Run Now» в Semaphore, тестовый аккаунт на проде и кнопки в админке, которые что-то меняют. Основание — [`AGENTS.md`](../../AGENTS.md), раздел «Release and production boundary».
> - Такие шаги помечены **[«да»]**. Одно «да» действует на один шаг.
> - Ключи и пароли не выводить ни в чат, ни в терминал, ни в лог. Команды ниже проверяют только, задана ли переменная.

> **Состояние на 15.10.2026, 00:10 (UTC+4).** Первый выкат уже состоялся: контейнеры созданы 14.10 в 19:13 UTC (23:13 UTC+4), деплой применил 24 миграции ENG и `20261015_0001` и записал их в `portal_migrations` (проверено чтением). На проде: `HE_ENG_AUTO_LAUNCH=0`, пул пуст, ночного добора ENG нет, ENG-аккаунтов 2. Разделы 0–8 ниже описывают первый выкат и оставлены для истории; для второго выката (правки этого раунда) — разделы 5.4, 6 и 10.

## Коротко для владельца

1. **ENG-порт уже в `main`.** Он там с 14.10, 22:21 по UTC+4. Ночной плановый деплой выкатит его сам, если его не остановить. Решите до ночи, выкатываем ли без правок (раздел 0).
2. **До выката нужно четыре вещи:**
   - лимиты денег — это настройка;
   - закрыть регистрацию в обход нашего лимита — миграция или настройка;
   - правда в кабинете про автозапуск — правка кода;
   - ваш ответ по изменениям в русском инструменте сотрудников.
3. **После выката пул ящиков не наполняем.** Английским клиентам «Включить отправку» не нажимаем, пока не выкачены правки #5–#7 (раздел 9).
4. **Если придётся откатывать,** сначала выключаем ночной добор ENG и ставим ENG-кампании на паузу, потом откатываем код (раздел 11). Иначе старый код начнёт каждую ночь покупать сборы для английских проектов.

## 0. Сначала: ENG-порт уже в `main`

Состояние по git на 14.10.2026, 22:35 (UTC+4):

- PR #2930 (Sergey → test) и #2931 (test → main) слиты в 22:21. `main` = `a6315091c`.
- В `main` вошли:
  - все 34 коммита ENG-порта (слияние `40d17e0b3`);
  - чужие коммиты из раздела 1.1.
- Правок этого раунда аудита (ветка `claude/eng-audit-fixes-20261014`) в `main` **нет**. Блокеры #1–#3 в коде `main` не закрыты.
- **Ночной плановый деплой** Semaphore выкатывает `main`, если тот сдвинулся с прошлого выката. По записям прошлых выкатов (23.09) он стартует в 05:00 МСК, то есть в 06:00 по UTC+4 (02:00 UTC). Если ничего не делать, ENG-порт уедет на прод ближайшей ночью:
  - без правок #1–#3;
  - с повторным прогоном 24 миграций (раздел 5).

### 0.1 Что сейчас на проде (только чтение)

Подключение — в разделе 3.

```sh
cat /home/Portal/prod/last_deploy_sha
docker inspect portal-worker-hypothesis-engine --format '{{.HostConfig.Memory}} {{.Created}}'
```

Как читать результат:
- `last_deploy_sha` равен `a6315091c…` или новее — ENG-код уже на проде. Тогда сразу делайте разделы 6 (настройки), 8 (смоук) и 9 (держим пул).
- Память `536870912` (512 МБ) — на проде ещё старый код. `2147483648` (2 ГБ) — уже новый.

Расписание проверить в Semaphore: проект Portal → Schedulers.

### 0.2 Выбор владельца **[«да»]**

- **Вариант А: выкатываем текущий `main`, правки — вторым выкатом.**
  - До выката сделать разделы 4–6: проверки, журнал миграций, лимиты денег. Прямую регистрацию закрыть настройкой (6.3) или ранним накатом `20261015_0010` (5.4).
  - До второго выката не звать английских клиентов: кабинет будет обещать автозапуск, которого нет (#3).
- **Вариант Б: ждём правок.** Владелец выключает ночное расписание в Semaphore до готовности раунда правок. Пока оно выключено, не уходят и русские правки, слитые в `main`.

## 1. Что едет и что не едет

### 1.1 Состав `main` сверх прошлого выката

| Что | Коммиты | Миграции |
|---|---|---|
| ENG-порт: кабинет, самообслуживание, отправка через пул, блокировки | 34 коммита, слияние `40d17e0b3` | 24 файла `20260920_0001` … `20261013_0001`. Уже применены на проде вручную 14.10, но **не записаны** в журнал `portal_migrations` |
| VE2: проверяемые аудитории (`02b884f84`) | 1 | `20261015_0001_ve_audience_scope.sql`: аддитивная, применится на Step 1.1 |
| Прочее | `d13e10fbe` (signals-ru read-only), `e991995f2` (e-mail-скрейпер), `031992c21` (ENG, 2 строки) | нет |

Про коммит VE2 `02b884f84`:
- аудит ENG его не проверял, нужна отдельная проверка и «да» владельца;
- оба его допуска (`VE_AUDIENCE_SCOPE_PROJECT_IDS`, `VE_AUDIENCE_GENERATION_PROJECT_IDS`) по умолчанию пустые;
- его заметка: [`docs/design/2026-10-15-ve-audience-controlled-rollout.md`](../design/2026-10-15-ve-audience-controlled-rollout.md).

Второй выкат (раздел 10) добавит:
- правки этого раунда из ветки `claude/eng-audit-fixes-20261014`, после проверки через Sergey → test → main;
- коммит VE2 `a6b2b1a7b`, который уже есть на Sergey;
- ещё три правки вне аудита (раздел 10, «Что ещё входит во второй выкат»);
- новые миграции раунда. Их **нужно применить** (раздел 5.4). В рабочем дереве раунда их четыре:
  - `20261015_0010_profiles_market_service_only.sql` — триггер регистрации `handle_new_user` берёт рынок только из `raw_app_meta_data`, который пишет одна сервис-роль (#2);
  - `20261015_0011_he_us_spend_sum_24h.sql` — функция `he_us_provider_spend_sum`, сумма расхода всего рынка `us` за 24 ч, для общего суточного потолка ENG `HE_US_ENG_DAY_SPEND_CAP_USD` (#1).
  - `20261015_0012_he_provider_usage_created_idx.sql` — частичный индекс журнала расхода ENG для этой суммы. Помечен `-- migrate:no-transaction` (`create index concurrently`): руками применять без `-1`.
  - `20261015_0020_he_eng_dnc_removals.sql` — таблицы и функции снятия адресов Do-not-contact с идущих кампаний. Флаг `HE_ENG_DNC_REMOVE` выключен, код с выключенным флагом их не читает.

  Имена и содержимое сверить с итоговым коммитом раунда.

### 1.2 Список правок аудита и чем каждая закрывается

| # | Проблема | Мешает выкату? | Чем закрывается |
|---|---|---|---|
| 1 | ENG тратит тот же баланс Requesty и Serper, что VE2 и инструмент сотрудников; все потолки расходов выключены | да | настройки (раздел 6); после второго выката — ещё общий суточный потолок ENG (`HE_US_ENG_DAY_SPEND_CAP_USD` + миграция `20261015_0011`); до широкого открытия регистрации — отдельные ключи ENG |
| 2 | Прямой `POST /auth/v1/signup` с `market:'eng'` создаёт ENG-аккаунт в обход лимита «3 в час с IP» | да | миграция раунда `20261015_0010` (можно применить заранее, 5.4) или `MAIN_DISABLE_SIGNUP=true` (раздел 6.3) |
| 3 | Кабинет и письма обещают автозапуск и письмо «sending started», а `HE_ENG_AUTO_LAUNCH=0` | да | код раунда правок |
| 4 | Английские письма русских проектов в инструменте сотрудников изменились; плюс другие заметные сотрудникам изменения (приложение А) | да, нужен ответ владельца | ответ «оставляем / выключаем для RU» по каждому пункту |
| 5 | «Перезапустить исследование» у ENG-проекта стирает список кампаний, на который опираются пауза, блок и пул | до первого ящика в пуле | код |
| 6 | Пул по умолчанию в account-2, а ответы этого workspace отдаёт партнёрское API Mailganer | до первого ящика в пуле | решение владельца + код или настройка |
| 7 | «Включить отправку» и письмо о ней не смотрят, есть ли свободные ящики | до первого ящика в пуле | код; до него кнопку не нажимать |
| 8 | ENG-аккаунт может слать через свои (BYO) ящики, а блок не гасит их очередь | да, если проверка 4.4 (j) больше 0 | код |
| 9 | После отката старый ночной крон игнорирует паузу добора и покупает сборы | — | порядок отката (раздел 11) |
| 10 | Любой вошедший пользователь читает все строки `profiles` (было и раньше, не из-за ENG) | нет | отдельная задача |

Что вошло в раунд правок, сверить по итоговому отчёту раунда. Пункт, которого там нет, остаётся открытым.

### 1.3 Не едет и не должен ехать

- `HE_ENG_AUTO_LAUNCH` остаётся `0`, автозапуск не включаем.
- `HE_ENG_DNC_REMOVE` не включаем: код снятия Do-not-contact с кампаний едет во втором выкате выключенным (раздел 10).
- Пул `he_sending_pool` остаётся пустым (раздел 9).

## 2. Решения владельца до выката **[«да»]**

1. По каждому пункту приложения А: оставляем как есть или выключаем для русских проектов (#4). Пока нет ответа, раунд правок в `main` не сливать.
2. Регистрация (#2): закрывать миграцией раунда (если она есть в релизе), настройкой `MAIN_DISABLE_SIGNUP=true` или обоими способами.
3. Суммы потолков расходов (#1): на клиента за сутки и за всё время, а также цена 1000 запросов Serper.
4. Пул (#6), до первого ящика: отдельный workspace для пула, отличный от партнёрского, или фильтр партнёрского API по кампаниям Mailganer.
5. Для кампаний пула:
   - `stop_for_company` — останавливать ли письма коллегам того, кто ответил;
   - заголовок отписки выключить явно, по правилу «без отписки в письмах».
6. Порт 3000 портала слушает все интерфейсы. Привязать к `127.0.0.1` (правка compose, отдельный PR)?
7. Журнал миграций: записать 24 имени руками заранее (раздел 5) или дать деплою прогнать их ещё раз.
8. Память воркера гипотез: 2 ГБ, если запас хоста позволяет (4.6). Иначе 1 ГБ с `NODE_OPTIONS=--max-old-space-size=768` — это правка compose и отдельное «да».
9. Тестовый ENG-аккаунт на проде для смоука (8.6), кто его заводит и что потом с ним делать.

## 3. Как подключаться

SSH — по [`docs/ssh-access.md`](../ssh-access.md): `root@139.60.162.24`, ключ из этого документа, проверку ключа сервера не отключать. Доступ по SSH сам по себе не даёт права на запись.

Основная БД:

```sh
docker exec -i main-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1
```

Любое чтение оборачивать так:

```sql
begin read only;
set local statement_timeout = '20s';
-- запросы
rollback;
```

Если запрос внутри упал, транзакция прервана. Сделайте `rollback;` и начните заново.

Не выбирайте `collect_info`, `data` и `launch_info` целиком: это мегабайты на строку. Запросы ниже достают только нужные поля.

## 4. Проверки только на чтение (до выката)

### 4.1 Журнал миграций

```sql
begin read only;
select f.name, m.applied_at
  from unnest(array[
    '20260920_0001_he_rls_lockdown.sql',
    '20260925_0001_ve_function_revokes_catchup.sql',
    '20260926_0001_he_emails_per_company.sql',
    '20260926_0002_he_launch_schedule.sql',
    '20260929_0001_he_base_transient_resume.sql',
    '20260929_0002_he_site_profile_active_unique.sql',
    '20260930_0001_he_projects_autopilot_error.sql',
    '20260930_0002_he_catalog_cursor.sql',
    '20260930_0003_he_vertical_dry.sql',
    '20260930_0004_he_refill_reservations.sql',
    '20260930_0005_he_capacity_pause.sql',
    '20261004_0001_he_refill_carryover.sql',
    '20261008_0001_he_active_job_unique.sql',
    '20261009_0001_he_provider_spend_sum.sql',
    '20261009_0002_he_project_cancel_marker.sql',
    '20261010_0001_he_eng_paid_access.sql',
    '20261010_0002_he_eng_paid_limits_lock.sql',
    '20261010_0003_he_chain_active_unique.sql',
    '20261011_0001_he_sending_pool.sql',
    '20261011_0002_he_eng_sending.sql',
    '20261011_0010_activity_replied_campaign_idx.sql',
    '20261012_0001_he_eng_auto_launch.sql',
    '20261012_0002_he_eng_client_emails.sql',
    '20261013_0001_he_eng_account_blocks.sql'
  ]) as f(name)
  left join public.portal_migrations m on m.name = f.name
 order by f.name;

select name, applied_at from public.portal_migrations where name like '20261015%' order by name;
rollback;
```

`applied_at` пустой — файла в журнале нет. Ожидается, что пусты все 24: их применяли руками и в журнал не записывали.

### 4.2 Объекты 24 миграций на месте

```sql
begin read only;
set local statement_timeout = '20s';

-- 15 таблиц: present не должен быть пустым ни у одной
select t, to_regclass('public.' || t) as present
  from unnest(array['he_launch_schedule','he_catalog_cursors','he_refill_daily_budgets',
    'he_refill_daily_reservations','he_refill_carryover','he_eng_email_verifications',
    'he_eng_rate_events','he_sending_pool','he_eng_sending_access','he_eng_launch_sending',
    'he_eng_campaign_status','he_eng_launch_intent','he_eng_auto_launch',
    'he_eng_client_emails','he_eng_account_blocks']) as t;

-- 6 индексов: все indisvalid = true
select c.relname, i.indisvalid
  from pg_index i join pg_class c on c.oid = i.indexrelid
 where c.relname in ('he_jobs_one_active_site_profile','he_jobs_one_active_template_per_base',
   'he_jobs_one_active_base_analyze_per_base','he_jobs_one_active_chain_per_vertical',
   'ix_instantly_activity_replied_campaign','idx_funded_created_id');

-- 4 колонки-метки: должно быть 4 строки
select table_name, column_name
  from information_schema.columns
 where table_schema = 'public'
   and (table_name, column_name) in (('he_auto_pipeline_configs','refill_paused_at'),
        ('he_projects','cancelled_at'), ('he_projects','autopilot_error'), ('he_bases','auto_resumes'));

-- новое тело функции автоподъёма: true
select prosrc like '%cancelled_at%' as new_body
  from pg_proc where proname = 'he_auto_resume_transient_bases';
rollback;
```

Если чего-то нет или индекс невалиден, журнал (раздел 5) **не записывать**. Сначала разобраться с владельцем.

### 4.3 Регистрация в обход (#2)

```sql
begin read only;
select position('raw_user_meta_data->>''market''' in p.prosrc) > 0 as market_from_user_metadata
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'handle_new_user';
rollback;
```

```sh
docker exec main-auth printenv GOTRUE_DISABLE_SIGNUP
```

Дыра открыта, если `market_from_user_metadata = true` и `GOTRUE_DISABLE_SIGNUP` равен `false` или пуст.

### 4.4 Данные ENG

```sql
begin read only;
set local statement_timeout = '20s';

-- (e) us-базы в работе; выкатывать, только когда ни у одной нет 'dispatched'
--     (иначе конструктор баз отправится и оплатится второй раз)
select b.id, b.status, b.collect_info->'construct'->>'status' as construct
  from public.he_bases b join public.he_projects p on p.id = b.project_id
 where p.market = 'us' and b.status in ('collecting','analyzing');

-- (f) шаблоны, застрявшие посреди запуска: должно быть 0
select count(*) from public.he_templates where launch_info ? 'pending';

-- (g) активные задачи движка гипотез
select stage, status, count(*) from public.he_jobs
 where status in ('pending','running') group by 1, 2;

-- (h) конфиги ночного добора us-проектов
select c.project_id, c.enabled, c.daily_leads_cap, c.last_run_at, c.refill_paused_at
  from public.he_auto_pipeline_configs c join public.he_projects p on p.id = c.project_id
 where p.market = 'us';

-- (i) забаненные ENG-аккаунты без метки остановки (список для 8.9)
select u.id, u.email
  from auth.users u join public.profiles p on p.id = u.id
 where p.market = 'eng' and u.banned_until > now()
   and not exists (select 1 from public.he_eng_account_blocks b where b.user_id = u.id and b.active);

-- (j) свои (BYO) ящики ENG-аккаунтов: если больше 0, правка #8 мешает выкату.
--     Неотправленная очередь — это 'pending' и 'sending': claim_byo_messages
--     переводит взятые письма в 'sending', и зависшие там воркер берёт снова.
select count(*) from public.client_mailbox_accounts m
  join public.profiles p on p.id = m.client_user_id
 where p.market = 'eng' and m.status = 'verified';
select m.status, count(*) from public.client_byo_messages m
  join public.profiles p on p.id = m.client_user_id
 where p.market = 'eng' and m.status in ('pending', 'sending')
 group by 1;

-- (k) пул и выключатель отправки: ожидается 0 строк и 0
select status, instantly_account_id, count(*) from public.he_sending_pool group by 1, 2;
select count(*) from public.he_eng_sending_access where enabled;

-- (l) расход без проекта: потолок «за всё время» его не видит (нужно до 6.2)
select l.request_id, count(*) from public.application_logs l
 where l.source = 'he_provider_usage'
   and not exists (select 1 from public.he_projects p where p.id::text = l.request_id)
 group by l.request_id;
rollback;
```

Запрос (l) читает весь журнал расхода. Если он упал по таймауту, повторить его отдельно с `set local statement_timeout = '120s'`.

Отдельно проверить, не чистит ли расписание журнал `application_logs`. Если чистит, потолки «за всё время» на деле становятся потолками за 30 дней.

```sql
begin read only;
select jobname, schedule, command from cron.job where command ilike '%cleanup_application_logs%';
rollback;
```

Если схемы `cron` нет, запрос упадёт. Это нормально: значит, такого расписания нет.

Как читать (j), если больше 0. После второго выката ENG-аккаунт уже не поставит новую кампанию через свои ящики: ответ 403. Блокировка аккаунта выключает его ящики и отменяет очередь. Но письма, которые уже стоят в очереди у **незаблокированного** аккаунта, воркер продолжит слать: он не смотрит ни рынок, ни выключатель отправки ENG. Что с ними делать, решает владелец до выката.

#### Аккаунты ENG: что поменяет второй выкат

Правки раунда меняют три вещи в доступе ENG-аккаунта:
- подтверждение почты и сброс пароля теперь смотрят на адрес входа из `auth.users`, а не на `profiles.email`;
- запуск кампаний (`POST /api/client/launches`) и оплата тарифа (`/api/client/payment`) отвечают ENG-аккаунту 403;
- сброс пароля ENG теперь присылает одноразовую ссылку, а не новый пароль.

Посмотреть до первого выката и ещё раз перед вторым:

```sql
begin read only;
set local statement_timeout = '20s';

-- (m) адрес профиля не совпадает с адресом входа. Сброс пароля второго выката
--     ищет ENG-аккаунт по profiles.email и сверяет его с адресом входа. У таких
--     аккаунтов «Forgot password?» не пришлёт ни ссылку, ни пароль.
--     Ожидается 0 строк.
select p.id, p.email as profile_email, u.email as sign_in_email
  from public.profiles p join auth.users u on u.id = p.id
 where p.market = 'eng' and p.email is distinct from lower(u.email);

-- (n) почта подтверждена, но на другой адрес, чем адрес входа. Второй выкат
--     сверяет подтверждение с адресом входа, и эти клиенты снова станут
--     «не подтверждёнными»: платные шаги встанут до подтверждения.
--     Ожидается 0 строк.
select v.user_id, v.email as verified_email, u.email as sign_in_email, v.verified_at
  from public.he_eng_email_verifications v
  join public.profiles p on p.id = v.user_id
  join auth.users u on u.id = v.user_id
 where p.market = 'eng' and p.role = 'client' and v.verified_at is not null
   and lower(trim(v.email)) is distinct from lower(trim(u.email));

-- (o) ENG-аккаунты с активным русским тарифом. После второго выката запуск
--     кампаний и оплата тарифа отвечают им 403. Ожидается 0 строк.
select t.user_id, t.tariff_type, t.is_active, t.updated_at
  from public.client_tariffs t join public.profiles p on p.id = t.user_id
 where p.market = 'eng' and t.is_active;

-- (p) ENG-клиенты без строки client_tariffs. Наша регистрация (/api/signup)
--     всегда создаёт её с is_active = false. Аккаунт без строки, скорее всего,
--     заведён прямым POST /auth/v1/signup в обход лимита (#2), или вставка
--     тарифа при регистрации упала (в журнале signup.tariff_insert_failed).
select p.id, p.email, p.created_at
  from public.profiles p
 where p.market = 'eng' and p.role = 'client'
   and not exists (select 1 from public.client_tariffs t where t.user_id = p.id);
rollback;
```

Как читать:
- **(m) не пусто.** До второго выката показать владельцу. Если сотрудник убедился, что адрес входа и есть адрес клиента, профиль выравнивается одной строкой на аккаунт **[«да»]**:

  ```sql
  update public.profiles p set email = lower(u.email)
    from auth.users u
   where u.id = p.id and p.market = 'eng' and p.id = '<id из (m)>';
  ```

  Пока (m) не разобрано, бэкфилл 8.8 для этих аккаунтов не делать: он пишет адрес профиля, а второй выкат сверяет с адресом входа.
- **(n) не пусто.** В БД ничего не править. После второго выката клиент увидит просьбу подтвердить почту, получит ссылку на адрес входа и подтвердит его сам. Владелец решает, предупреждать ли клиента заранее.
- **(o) не пусто.** До второго выката владелец решает, чьи это аккаунты и зачем им русский тариф. История запусков (`GET /api/client/launches`) у них по-прежнему читается.
- **(p) не пусто.** Показать владельцу: это след дыры #2 или сбоя регистрации. Второй выкат этим аккаунтам ничего не меняет. Блокировка по карточке в `/admin/eng-clients` — отдельное «да» на каждый аккаунт.

### 4.5 Фоновые работы простаивают

Деплой останавливает все воркеры. Выкатывать, когда VE2, ручной скоринг и автопайплайн ничего не делают.

```sql
begin read only;
select stage, count(*) from public.ve_jobs where status = 'running' group by 1;
select count(*) from public.client_manual_score_runs where status = 'processing';
rollback;
```

```sh
docker logs --since 15m portal-worker-autopipeline 2>&1 | tail -20
```

### 4.6 Хост

```sh
# ночной добор ENG: строка должна быть
crontab -l | grep -n heAutoPipelineCron
# ожидается:
# 20 3 * * * docker exec portal-worker-hypothesis-engine node /app/workers/heAutoPipelineCron.js >> /var/log/portal/he-auto-pipeline.log 2>&1
ls /etc/cron.d

# запас памяти под воркер 2 ГБ: самое малое значение должно быть не меньше 1536 (МиБ)
for i in $(seq 10); do free -m | awk '/^Mem:/{print $7}'; sleep 30; done

# порт 3000: на каких адресах слушает и закрыт ли снаружи
ss -tlnp | grep ':3000 '
ufw status 2>/dev/null | head -20
```

Без строки крона health-check начнёт присылать алерт по каждому включённому us-конфигу, который не обходили больше 26 часов.

### 4.7 Файл `/home/Portal/prod/.env`

Несекретные значения можно смотреть целиком:

```sh
cd /home/Portal/prod
grep -nE '^(HE_ENG_AUTO_LAUNCH|HE_US_SENDING_REQUIRES_ACTIVATION|HE_US_[A-Z_]*SPEND_CAP_USD|HE_US_SERPER_USD_PER_1000|HE_US_POOL_WORKSPACE|HE_US_MAX_RESEARCH_PER_DAY|HE_AUTO_RESUME_TRANSIENT|HE_AUTOPILOT_RECONCILE|HE_VERTICAL_DRY_STOP|HE_GATE_HYPOTHESIS_SCOPE|HE_COLLECT_WIDEN|HE_STAGE_WATCHDOG_MODE|PARTNER_ACTIVITY_ACCOUNT_ID|HEALTH_HE_REFILL_STUCK_HOURS|DB_MIGRATION_LOCK_TIMEOUT|VE_AUDIENCE_SCOPE_PROJECT_IDS|VE_AUDIENCE_GENERATION_PROJECT_IDS)=' .env
grep -c '^HE_ENG_AUTO_LAUNCH=' .env      # должно быть 1
grep -o '^SMTP_FROM_[A-Z_]*=' .env       # имена, без значений
```

Секретные — только «задан или пуст»:

```sh
cd /home/Portal/prod
for v in HE_US_REQUESTY_API_KEY HE_US_SERPER_API_KEY PARTNER_API_KEY SMTP_HOST SMTP_USER SMTP_PASS; do
  grep -q "^$v=." .env && echo "$v: задан" || echo "$v: пуст"
done
```

Как должно быть:
- ровно одна строка `HE_ENG_AUTO_LAUNCH=0`;
- `HE_US_SENDING_REQUIRES_ACTIVATION` нет или не равен `0`/`false`/`off`/`no`;
- `HE_AUTO_RESUME_TRANSIENT`, `HE_AUTOPILOT_RECONCILE`, `HE_VERTICAL_DRY_STOP`, `HE_GATE_HYPOTHESIS_SCOPE`, `HE_COLLECT_WIDEN` и `HE_STAGE_WATCHDOG_MODE` не заданы или заданы сознательно;
- SMTP задан;
- `VE_AUDIENCE_*` пусты, пока владелец не разрешил пилот VE2;
- значение `PARTNER_ACTIVITY_ACCOUNT_ID` записать: оно нужно для решения #6.

## 5. Журнал миграций **[«да»]**

24 файла ENG уже применены руками 14.10, но в журнале `public.portal_migrations` их нет. Если журнал не записать, Step 1.1 деплоя (`app/scripts/db/ensureDatabase.js`) прогонит их ещё раз, пока старые воркеры работают. Последствия:
- блокировки `ACCESS EXCLUSIVE` на таблицах `he_*`;
- три `lock table he_jobs`;
- пересборка индекса `ix_instantly_activity_replied_campaign` через `drop` и `create concurrently`.

Чем это опасно:
- Каждый файл ждёт блокировку не дольше 30 с (`DB_MIGRATION_LOCK_TIMEOUT`, по умолчанию `30s`). Не дождался — деплой прерывается с алертом «DEPLOY ABORTED: migration precheck failed», на проде остаётся старая сборка.
- Каждый следующий деплой, включая русские хотфиксы, будет пробовать эти файлы снова.
- Во время бэкапа индекс может остаться удалённым или невалидным.

### 5.1 Запись журнала

Только после того, как проверки 4.1 и 4.2 прошли чисто. Одна транзакция:

```sql
begin;
insert into public.portal_migrations (name)
select unnest(array[
  '20260920_0001_he_rls_lockdown.sql',
  '20260925_0001_ve_function_revokes_catchup.sql',
  '20260926_0001_he_emails_per_company.sql',
  '20260926_0002_he_launch_schedule.sql',
  '20260929_0001_he_base_transient_resume.sql',
  '20260929_0002_he_site_profile_active_unique.sql',
  '20260930_0001_he_projects_autopilot_error.sql',
  '20260930_0002_he_catalog_cursor.sql',
  '20260930_0003_he_vertical_dry.sql',
  '20260930_0004_he_refill_reservations.sql',
  '20260930_0005_he_capacity_pause.sql',
  '20261004_0001_he_refill_carryover.sql',
  '20261008_0001_he_active_job_unique.sql',
  '20261009_0001_he_provider_spend_sum.sql',
  '20261009_0002_he_project_cancel_marker.sql',
  '20261010_0001_he_eng_paid_access.sql',
  '20261010_0002_he_eng_paid_limits_lock.sql',
  '20261010_0003_he_chain_active_unique.sql',
  '20261011_0001_he_sending_pool.sql',
  '20261011_0002_he_eng_sending.sql',
  '20261011_0010_activity_replied_campaign_idx.sql',
  '20261012_0001_he_eng_auto_launch.sql',
  '20261012_0002_he_eng_client_emails.sql',
  '20261013_0001_he_eng_account_blocks.sql'
])
on conflict (name) do nothing;
notify pgrst, 'reload schema';
commit;
```

`20261015_0001` (VE2) и миграции раунда правок сюда **не вписывать**: на проде их ещё нет, их применит деплой.

### 5.2 PostgREST видит новые таблицы

Без перечитки схемы PostgREST отвечает на новые таблицы кодом `PGRST205`. Новый код читает его как «таблицы нет» и пропускает проверки:
- гейт подтверждения почты;
- блокировки в фоновых путях;
- автозапуск;
- создание проекта, которое тогда отвечает 503.

Проверка из контейнера портала. Ключ берётся из окружения контейнера и не печатается:

```sh
docker exec portal node -e '
const u = process.env.NEXT_PUBLIC_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: k, Authorization: "Bearer " + k };
Promise.all([
  fetch(u + "/rest/v1/he_eng_account_blocks?select=user_id&limit=1", { headers: h }).then(r => "he_eng_account_blocks " + r.status),
  fetch(u + "/rest/v1/rpc/he_provider_spend_sum?p_project_id=00000000-0000-0000-0000-000000000000", { headers: h }).then(r => "he_provider_spend_sum " + r.status),
]).then(x => console.log(x.join("\n")));'
```

Ожидается `200` и `200`. Если в ответе `404`, повторить `notify pgrst, 'reload schema';` **[«да»]** и проверить снова.

### 5.3 Если владелец решил журнал не записывать

Тогда Step 1.1 прогонит 24 файла и запишет их сам. Условия:
- деплой только в окне из раздела 7, вне бэкапов;
- на время этого прогона поднять `DB_MIGRATION_LOCK_TIMEOUT` в `.env`, например до `120s`, а после деплоя убрать **[«да»]**. Формат значения: число с `ms`, `s` или `min`.

### 5.4 Новые миграции

| Файл | Когда |
|---|---|
| `20261015_0001_ve_audience_scope.sql` (VE2) | Step 1.1 первого выката |
| `20261015_0010_profiles_market_service_only.sql` (раунд правок, #2) | Step 1.1 второго выката, или заранее руками (ниже) |
| `20261015_0011_he_us_spend_sum_24h.sql` (раунд правок, #1) | Step 1.1 второго выката |
| `20261015_0012_he_provider_usage_created_idx.sql` (раунд правок, #1; вне транзакции) | Step 1.1 второго выката |
| `20261015_0020_he_eng_dnc_removals.sql` (Do-not-contact, флаг выключен) | Step 1.1 второго выката |

Имена — по рабочему дереву раунда на момент написания. Перед вторым выкатом сверить их с итоговым коммитом и прочитать шапку каждого файла: что меняет и почему безопасно.

Требование к раунду: каждая такая миграция идемпотентна, безопасна до выката кода и безопасна для старого кода. Шапки обоих файлов это утверждают:
- `0011` только добавляет функцию. Старый код её не зовёт, а без неё новый код считает общий расход неизвестным и пропускает.
- `0010` переписывает одну функцию `handle_new_user`, триггер не пересоздаётся.

`20261015_0010` можно применить заранее, не дожидаясь деплоя **[«да»]**. Это закроет дыру #2 и на сегодняшнем проде. Совместимость:
- старая версия `/api/signup` сама пишет `market='eng'` в профиль сервис-ролью (проверено на `8c447a220`), так что ENG-регистрация через наш сайт не сломается;
- русские регистрации рынок не задают и как получали `ru`, так и получают.

После применения запрос 4.3 должен дать `market_from_user_metadata = false`.

Как применять руками, по одному файлу:

```sh
# с Mac, из корня репозитория, на нужном коммите
ssh -i /Users/cybermart/.ssh/portal_hostkey_mac_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes root@139.60.162.24 \
  'docker exec -i main-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1' \
  < supabase/migrations/20261015_0010_profiles_market_service_only.sql
```

Правила ручного применения:
- `-1` (одна транзакция) обязателен: `lock table` без транзакции не работает;
- исключение — файлы, у которых первая строка `-- migrate:no-transaction`: их запускать без `-1`;
- после применения вписать имя файла в `portal_migrations` так же, как в 5.1, и сделать `notify pgrst, 'reload schema'`.

## 6. Настройки **[«да»]**

### 6.1 `/home/Portal/prod/.env`

Деплой этот файл не перезаписывает, только сохраняет его копию. Полный деплой пересоздаёт все контейнеры, поэтому строки, внесённые **до** деплоя, подхватятся сами.

```
# Деньги ENG (#1): обязательны до выката
HE_US_CLIENT_DAY_SPEND_CAP_USD=<сумма владельца: $ на клиента за последние 24 ч>
HE_US_CLIENT_SPEND_CAP_USD=<сумма владельца: $ на клиента за всё время>
HE_US_SERPER_USD_PER_1000=<цена 1000 запросов по тарифу Serper>
# необязательно: потолок проекта за 24 ч
HE_US_PROJECT_DAY_SPEND_CAP_USD=<сумма владельца>
# общий потолок всего ENG за 24 ч: читает только код второго выката
# (нужна миграция 20261015_0011); старый код строку не читает, поэтому
# её можно внести заранее
HE_US_ENG_DAY_SPEND_CAP_USD=<сумма владельца: $ на весь рынок us за последние 24 ч>

# Отдельные ключи ENG (#1): до широкого открытия регистрации
HE_US_REQUESTY_API_KEY=<ключ Requesty со своим балансом или лимитом>
HE_US_SERPER_API_KEY=<ключ ДРУГОГО аккаунта Serper>

# Автозапуск: ровно одна строка, значение 0
HE_ENG_AUTO_LAUNCH=0
```

Пояснения:
- **Как считаются потолки.** Расход берётся по журналу `he_provider_usage`, это нижняя граница настоящего. Без `HE_US_SERPER_USD_PER_1000` поиск Serper в долларах не считается вовсе. Превышение ставит проект на паузу и шлёт алерт.
- **Отдельные ключи.** Без них все ENG-вызовы идут на ключ и баланс, которые делят VE2 и инструмент сотрудников. Второй ключ того же аккаунта Serper ничего не разделяет: нужен другой аккаунт.
- **Как проверить ключи, не печатая их.** Ключ Requesty не должен совпадать с общим:

  ```sh
  cd /home/Portal/prod
  a=$(grep '^HE_US_REQUESTY_API_KEY=' .env | tail -1 | cut -d= -f2-)
  b=$(grep '^OPENROUTER_HYPOTHESIS_ENGINE_API_KEY=' .env | tail -1 | cut -d= -f2-)
  [ -n "$a" ] && [ "$a" = "$b" ] && echo 'СОВПАДАЕТ с общим ключом' || echo 'не совпадает или не задан'
  ```

  Отдельный баланс видно только в кабинетах Requesty и Serper.
- **Необязательные строки:**
  - `HE_US_MAX_RESEARCH_PER_DAY` — запусков исследования на клиента в сутки, по умолчанию 5. Можно временно снизить.
  - `HEALTH_HE_REFILL_STUCK_HOURS=34` — убирает ложный оранжевый алерт «ENG ночной добор: … ноч(ей) не закрылись», пока порог не поправлен в коде. Сейчас по умолчанию 14 ч, а честная ночь теперь может идти дольше.
- **Общий потолок ENG** (`HE_US_ENG_DAY_SPEND_CAP_USD`, нужны миграции `0011` и `0012`). Пока сумма расхода всего рынка `us` за последние 24 часа выше порога, новые платные шаги ENG не ставятся ни у одного клиента: кабинет отвечает нейтральным текстом про временную паузу (в сборе базы и переписывании писем пока может показаться текст про лимит проекта — доработка следующим раундом), ночной добор пропускает ночь (в `he_auto_pipeline_runs` деталь `spend_held`). Долговременных пауз он не пишет: как только сумма опустится ниже порога, всё идёт дальше само, а пропущенные шаги подхватит следующая ночь или «Launch» клиента. Команде уходит алерт в health-бот. RU и VE2 он не трогает. Порог ставить с запасом: не меньше 1,5 × (активные рынки × стоимость ночного добора рынка + регистрации в день × стоимость первого дня клиента), иначе ночи будут пропускаться.
- **Пул (#6).** `HE_US_POOL_WORKSPACE` задавать только по решению владельца и до первого ящика в пуле.
  - Партнёрское API отдаёт события workspace из `PARTNER_ACTIVITY_ACCOUNT_ID`, а если он пуст — первого не основного аккаунта. Сейчас это `account-2`, workspace Mailganer.
  - Пул по умолчанию тоже лежит в `account-2`. Пул и партнёрский workspace должны различаться.

### 6.2 Перед включением `HE_US_CLIENT_SPEND_CAP_USD`

Посмотреть запрос 4.4 (l). Если строки есть, расход этих проектов потолок «за всё время» не видит. Владелец решает, включать ли потолок в таком виде.

В коде на этот шаг ссылаются как на «заметки выката, шаг 8» (`engClientSpend.ts`).

### 6.3 Закрыть прямую регистрацию: `MAIN_DISABLE_SIGNUP=true` (вариант #2б) **[«да»]**

Затрагивает общую авторизацию RU и ENG:
- прямой `POST /auth/v1/signup` начнёт получать отказ;
- создание пользователей через сервисный ключ (наш `/api/signup`) работает как раньше.

1. Узнать, где лежит стек, его файл compose и `.env` (только чтение):

   ```sh
   docker inspect main-auth --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
   docker inspect main-auth --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
   ```

   Убедиться, что сервис GoTrue в этом файле называется `auth`. `main-auth` — только имя контейнера, а compose принимает имя сервиса. Команда печатает одни имена сервисов, без значений:

   ```sh
   cd <каталог из шага 1>
   docker compose -p main-supabase -f <файл из шага 1> --env-file .env config --services
   # ожидается среди прочих: auth (и main-postgres, kong, rest, realtime, storage)
   ```

2. В `.env` этого каталога поставить строку `MAIN_DISABLE_SIGNUP=true`. Если она уже есть, поменять значение.
3. Пересоздать **только** сервис `auth`. Без `--force-recreate` правка не подхватится (правило из [`CLAUDE.md`](../../CLAUDE.md)):

   ```sh
   cd <каталог из шага 1>
   docker compose -p main-supabase -f <файл из шага 1> --env-file .env up -d --force-recreate --no-deps auth
   ```

   - Имя сервиса — `auth`, не `main-auth`. С `main-auth` compose ответит «no such service: main-auth», и регистрация останется открытой.
   - Не запускать `up -d` без имени сервиса или без `--no-deps`: так пересоздаётся весь стек `main-supabase`, включая `main-postgres`.

4. Сразу после:
   - `docker inspect main-auth --format '{{.Created}} {{.State.Status}}'` — контейнер создан только что и в состоянии `running`;
   - `docker exec main-auth printenv GOTRUE_DISABLE_SIGNUP` → `true` (здесь имя контейнера, это верно);
   - вход русского клиента и сотрудника на `polza-portal.ru` работает;
   - регистрация русского клиента через сайт работает.

Откат: вернуть `false` и снова выполнить шаг 3 той же командой (сервис `auth`). Затем `docker exec main-auth printenv GOTRUE_DISABLE_SIGNUP` → `false`.

### 6.4 Если `.env` правят после деплоя

Контейнеры читают `.env` только при создании. Новые строки подхватятся, только когда пересоздать те контейнеры, которые их читают:
- `HE_US_*` и `HE_ENG_*` читают `portal` и `worker-hypothesis-engine`;
- `HEALTH_*` читает `health-check`.

**[«да»]**. Пересоздавать, когда у воркера гипотез нет задачи в работе: в запросе 4.4 (g) нет строк `running`.

Команды — в той же форме, что у деплоя: с `DOCKER_GID` группы сокета docker. Сервис `portal` берёт его в `group_add` (`"${DOCKER_GID:-999}"`) и через эту группу ходит в `docker.sock`. Без переменной подставится 999. Если на хосте у сокета другая группа, `portal` потеряет доступ к docker, и страница ботов в админке (`lib/adminBots/docker.ts`) сломается до следующего деплоя.

```sh
cd /home/Portal/prod
sudo -n env DOCKER_GID=$(stat -c '%g' /var/run/docker.sock) docker compose --env-file .env -p portal -f docker-compose.prod.yml up -d --force-recreate --no-deps worker-hypothesis-engine
sudo -n env DOCKER_GID=$(stat -c '%g' /var/run/docker.sock) docker compose --env-file .env -p portal -f docker-compose.prod.yml up -d --force-recreate --no-deps portal
```

Для строк `HEALTH_*` так же пересоздать `health-check`:

```sh
sudo -n env DOCKER_GID=$(stat -c '%g' /var/run/docker.sock) docker compose --env-file .env -p portal -f docker-compose.prod.yml up -d --force-recreate --no-deps health-check
```

Сразу после пересоздания `portal` проверить группу, как это делает деплой (шаг 4.1):

```sh
stat -c '%g' /var/run/docker.sock
docker inspect portal --format '{{json .HostConfig.GroupAdd}}'
# во втором выводе должно быть число из первого, в кавычках
docker exec portal sh -lc 'test -r /var/run/docker.sock && test -w /var/run/docker.sock && echo ok'
```

Пересоздание `portal` — это минута недоступности кабинетов.

## 7. Окно и выкат **[«да»]**

### 7.1 Окна

Деплой **полный**: в выкат входит правка `docker-compose.prod.yml`, поэтому `DEPLOY_ALL=1`. Что это значит:
- портал уходит в режим обслуживания;
- останавливаются и пересоздаются все воркеры, включая VE2, ручной скоринг, автопайплайн и 12 реплик конструктора баз;
- затрагиваются стек Instantly DB и хосты рассыльщика.

Сколько длится:
- дренаж воркеров в худшем случае около 43 мин;
- у всей задачи деплоя предел 60 мин.

| UTC+4 | UTC | Что происходит |
|---|---|---|
| около 06:00 | около 02:00 | плановый ночной деплой Semaphore, по записям прошлых выкатов |
| 07:10–07:40 | 03:10–03:40 | **нельзя:** ночной добор ENG (крон 03:20 UTC) |
| 09:50–11:30 | 05:50–07:30 | **нельзя:** бэкапы main (06:00) и instantly (06:15 UTC) |
| 21:50–23:30 | 17:50–19:30 | **нельзя:** бэкапы main (18:00) и instantly (18:15 UTC) |

Чтобы деплой успел закончиться до запретного окна, начинать (UTC+4):
- 23:30–06:10;
- 07:40–08:50 — до начала рабочего дня, удобнее всего;
- 11:30–20:50 — днём сотрудники и русские клиенты увидят страницу обслуживания.

### 7.2 Прямо перед «Run Now»

Повторить:
- 4.4 (e), (f), (g) — в базах нет `dispatched`, `pending` в шаблонах 0;
- 4.5 — VE2, ручной скоринг и автопайплайн простаивают.

Убедиться, что разделы 5 и 6 сделаны или сознательно пропущены по решению владельца.

### 7.3 Запуск

Слияния Sergey → test → main и «Run Now» делает владелец:
1. Semaphore → Portal → Schedulers → Run Now.
2. В форме ветка `main`, файл `.semaphore/scheduled-deploy.yml`.
3. Run.

### 7.4 Что смотреть в логе

- Строка `[deploy-plan] full=1`.
- Step 1.1:
  - журнал записан (раздел 5) — строки `[db] Применяем миграцию (portal_migrations): …` только у новых файлов: в первом выкате `20261015_0001_ve_audience_scope.sql`, во втором — миграции раунда; затем `PostgREST schema cache reload requested`;
  - журнал не записан — все 24 файла плюс новые.
- `[drain] Gracefully stopping Hypothesis Engine (grace period: 300s (container StopTimeout))`, затем `[drain] Hypothesis Engine stopped`.
- В конце — Step 5 (перезапуск воркеров) и Step 6 (выход из режима обслуживания).

### 7.5 Если сломалось

- **«DEPLOY ABORTED: migration precheck failed».** На проде остаётся старая сборка.
  - Прочитать хвост ошибки.
  - Проверить, не остался ли индекс `ix_instantly_activity_replied_campaign` невалидным (запрос индексов из 4.2).
  - Повторять только в окне и после решения владельца по разделу 5.
- **Задача оборвалась между дренажем и Step 5.** Воркер гипотез стоит. **[«да»]**:

  ```sh
  cd /home/Portal/prod
  sudo -n env DOCKER_GID=$(stat -c '%g' /var/run/docker.sock) docker compose --env-file .env -p portal -f docker-compose.prod.yml start worker-hypothesis-engine
  ```

  Именно `start`, не `up`: поднимается старый контейнер. `DOCKER_GID` здесь ничего не меняет, он для единообразия с деплоем и 6.4.
- **Задачу убил предел 60 мин в Step 5.** Часть русских воркеров может остаться удалённой, а `last_deploy_sha` не записан. Повторный «Run Now» выкатит всё заново **[«да»]**.

## 8. Смоук после выката

8.1. Контейнер воркера гипотез:

```sh
docker inspect portal-worker-hypothesis-engine --format '{{.HostConfig.Memory}} {{.Config.StopTimeout}}'
# ожидается: 2147483648 300
docker exec portal-worker-hypothesis-engine printenv HE_ENG_AUTO_LAUNCH NODE_OPTIONS
# ожидается: 0 и --max-old-space-size=1536
```

8.2. Лог воркера:

```sh
docker logs --since 30m portal-worker-hypothesis-engine 2>&1 | grep -E 'worker starting|Stage watchdog|PGRST205|not applied|he_eng_launch_intent is missing'
```

- Должны быть строки `Hypothesis Engine worker starting` и `Stage watchdog [enforce]`.
- Не должно быть `PGRST205`, `not applied` и `he_eng_launch_intent is missing`.

8.3. Страницы:

```sh
for u in https://app.outreachos.xyz/login https://app.outreachos.xyz/signup; do
  printf '%s ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' "$u"
done
```

- Обе возвращают `200`.
- Сотрудник проверяет, что открываются `polza-portal.ru/tools/hypothesis-engine` и `/admin/eng-clients`.
- Русский клиент может войти, его дашборд открывается.

8.4. Health-check:

```sh
docker logs --since 30m portal-health-check 2>&1 | grep -E 'he-refill .* query skipped'
```

Ожидается пусто.

8.5. Русская часть:
- в логе VE2 нет `permission denied for function`: `docker logs --since 30m portal-worker-vertical-engine-v2 2>&1 | grep -c 'permission denied for function'` даёт 0;
- проект сотрудника открывается в инструменте гипотез;
- если владелец оставил английские письма русских проектов как были (#4), английская цепочка русского проекта пишется по-старому.

8.6. Тестовый ENG-аккаунт **[«да»]**, делает сотрудник:
1. Регистрация на `app.outreachos.xyz/signup` проходит.
2. Письмо с подтверждением приходит, ссылка подтверждает адрес.
3. Первый проект создаётся.
4. Второй проект отклоняется по правилу «один аккаунт — один сайт».
5. На шаге 3 «Launch» кабинет **не** обещает автозапуск. Ожидается текст «Automatic sending is not available right now…».
   - До второго выката (правка #3) там будет «Automatic launch is on…». Это и есть блокер #3: в таком случае клиентов не звать.
6. Платное исследование не запускать без отдельного «да».

8.7. Прямая регистрация (#2) **[«да»]**: создаёт мусорного пользователя, если дыра не закрыта.

```sh
docker exec portal node -e '
const u = process.env.NEXT_PUBLIC_SUPABASE_URL, k = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
fetch(u + "/auth/v1/signup", { method: "POST", headers: { apikey: k, "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.argv[1], password: process.argv[2], data: { market: "eng" } }) })
  .then(async r => { const j = await r.json().catch(() => ({})); console.log(r.status, j.error_code || j.code || j.msg || "", j.user ? j.user.id : (j.id || "")); });' \
  '<служебный тестовый адрес>' '<одноразовый пароль>'
```

```sql
begin read only;
select id, market from public.profiles where lower(email) = lower('<тот же адрес>');
rollback;
```

Как читать:
- Регистрация выключена (6.3) — ответ 4xx, профиля нет.
- Работает миграция раунда — профиль есть, но `market = 'ru'`.
- `market = 'eng'` — дыра открыта.

Созданного пользователя потом заблокировать или удалить. Это отдельное «да».

8.8. Бэкфилл подтверждений почты (шаг S1) **[«да»]**. В коде на него ссылаются как на «шаг 4 заметок выката» (`20261010_0001_he_eng_paid_access.sql`).

Сначала просмотр:

```sql
begin read only;
select p.id, p.email
  from public.profiles p
 where p.role = 'client' and p.market = 'eng' and coalesce(p.email, '') <> ''
   and exists (select 1 from public.he_projects h where h.created_by = p.id)
   and not exists (select 1 from public.he_eng_email_verifications v where v.user_id = p.id);
rollback;
```

Затем та же вставка, что в миграции. Она идемпотентна. Аккаунты из 4.4 (m) в неё не должны попасть, пока (m) не разобрано: вставка пишет адрес профиля, а второй выкат сверяет подтверждение с адресом входа.

```sql
insert into public.he_eng_email_verifications (user_id, email, verified_at, created_at)
select p.id, lower(p.email), now(), now()
  from public.profiles p
 where p.role = 'client'
   and p.market = 'eng'
   and coalesce(p.email, '') <> ''
   and exists (select 1 from public.he_projects h where h.created_by = p.id)
on conflict (user_id) do nothing;
```

8.9. Аккаунты из 4.4 (i) **[«да»]** на каждый: в `/admin/eng-clients` фильтр «Бан без остановки», остановка по карточке.

8.10. Первая ночь, после 03:20 UTC (07:20 по UTC+4):

```sh
grep 'Done:' /var/log/portal/he-auto-pipeline.log | tail -3
```

```sql
begin read only;
select project_id, status, created_at, completed_at, error
  from public.he_auto_pipeline_runs
 where created_at >= date_trunc('day', now())
 order by created_at;
rollback;
```

## 9. Держим пул

После выката **не добавлять ни одного ящика** в `he_sending_pool` («Пул ящиков ENG» в `/tools/hypothesis-engine`). Английским клиентам **не нажимать** «Включить отправку» в `/admin/eng-clients`, пока не выполнено всё ниже:

1. Выкачена правка #5: перезапуск исследования сотрудником отказывает (409), если у us-проекта есть запуск.
2. Решено и выкачено #6: пул в отдельном workspace или партнёрское API не видит ENG-кампании.
3. Выкачена правка #7: «Включить отправку» и письмо о ней учитывают свободные ящики пула.
4. Если проверка 4.4 (j) больше 0, выкачена правка #8 (BYO).
5. Владелец ответил по `stop_for_company` и заголовку отписки для кампаний пула (раздел 2, п. 5).
6. До того как широко открывать регистрацию: заданы отдельные ключи ENG (6.1).

Проверка, что пул держится. Только чтение, хоть каждый день:

```sql
begin read only;
select status, instantly_account_id, count(*) from public.he_sending_pool group by 1, 2;   -- 0 строк
select count(*) from public.he_eng_sending_access where enabled;                          -- 0
rollback;
```

Первый ящик в пул — отдельное «да» владельца после всех шести пунктов.

## 10. Второй выкат: раунд правок аудита

Что ещё входит во второй выкат, кроме правок аудита (раздел 1.2), — три правки:
- **Снятие адресов Do-not-contact с идущих кампаний клиента.** Миграция `20261015_0020_he_eng_dnc_removals.sql`, флаг `HE_ENG_DNC_REMOVE` выключен: пока флаг не включён, код новые таблицы не трогает и рассыльщика не зовёт. Перед включением нужны разовая живая проверка удаления лида и решение владельца. Заблокированному аккаунту (отметка блокировки ENG) роут списка отказывает в добавлении и удалении адресов, а воркер его заявки и строки откладывает и рассыльщика по ним не зовёт; после разблокировки они продолжаются сами.
- **Остановка платного исследования на почти пустом сайте без описания бизнеса.** Работает сразу, только для клиентов ENG: исследование встаёт до первого платного вызова, шаг 1 просит описание бизнеса и показывает кнопку «Save and continue». «Save and continue» проходит тот же гейт платных шагов, что «Try again»: блокировка, подтверждённая почта, потолки расхода клиента и проекта, общий суточный потолок ENG (`HE_US_ENG_DAY_SPEND_CAP_USD`). Не проверяется только лимит стартов исследования за сутки: продолжается та же джоба, новой нет.
- **Защита чтения сайтов в английском авторассыльщике `polzaOutreach`.** Работает сразу: внутренние адреса, порты кроме 80 и 443 и цепочки больше 10 переадресаций не читаются, страница читается не дальше первых 3 МБ. Следить за долей `no_corporate_email` в логах `worker-polza-outreach`.

1. Раунд проходит гейты на ветке. Владелец даёт «да» на пуш в Sergey. Ответы по #4 записаны (раздел 2).
2. Перед слиянием в `main` проверить список новых миграций:

   ```sh
   # <sha с прода> — значение last_deploy_sha из 0.1
   git diff --name-only <sha с прода> origin/main -- supabase/migrations supabase/instantly-migrations
   ```

   - Ожидаются `20261015_0010_profiles_market_service_only.sql`, `20261015_0011_he_us_spend_sum_24h.sql`, `20261015_0012_he_provider_usage_created_idx.sql` и `20261015_0020_he_eng_dnc_removals.sql` (флаг `HE_ENG_DNC_REMOVE` выключен, применить до кода), если их имена не поменялись. `0010` в списке будет и тогда, когда её уже применили руками (5.4): деплой её пропустит, если имя записано в `portal_migrations`. Кроме них в списке могут быть миграции VE2 из параллельной работы владельца (например `20261015_0002_ve_new_project_audiences.sql`) — их проверяет тот, кто вёл VE2.
   - Если первый выкат не случился, в списке будут ещё `20261015_0001` и, при незаписанном журнале, 24 файла ENG.
   - Прочитать шапки новых файлов (5.4).
3. **[«да»]** Если используется общий потолок ENG, внести `HE_US_ENG_DAY_SPEND_CAP_USD` в `.env` до деплоя (6.1).
4. Повторить разделы 4.2, 4.4 (e)–(g), (j), (m)–(p) и 4.5, затем выкатить по разделу 7. Если (m), (n) или (o) не пусты, сначала решение владельца по 4.4. Выкат будет полным, только если раунд меняет compose: смотреть `full=` в логе.
5. Смоук:
   - всё из раздела 8, что касается изменённого;
   - обязательно 8.6 п. 5: шаг 3 говорит «Automatic sending is not available right now…»;
   - обязательно 8.7: с миграцией `0010` прямая регистрация даёт профиль с `market = 'ru'`;
   - функция общего потолка видна PostgREST: в команде 5.2 заменить адрес на `/rest/v1/rpc/he_us_provider_spend_sum`, ожидается `200`;
   - обязательно сброс пароля ENG на тестовом аккаунте из 8.6 **[«да»]**, делает сотрудник:
     1. На `app.outreachos.xyz/login` нажать «Forgot password?» и ввести адрес тестового аккаунта.
     2. Приходит письмо «Reset your outreachOS password» со ссылкой. Пароля в письме нет. Старый пароль пока работает.
     3. Открыть ссылку: страница «Choose a new password» с двумя полями открывается.
     4. Ввести новый пароль дважды и сохранить. Ожидается «Your password was changed» и фраза «Every device that was signed in to this account has been signed out». Если фразы нет, сессии не отозваны: показать владельцу.
     5. Открыть ту же ссылку ещё раз. Форма откроется снова, это нормально: само открытие ссылку не тратит. Ввести другой пароль и сохранить. Ожидается «This link can no longer be used», пароль не меняется.
     6. Войти с паролем из п. 4: вход проходит. Старый пароль больше не подходит.

     Сброс ограничен: не чаще раза в минуту на адрес и не больше 3 запросов в час с одного IP и на один адрес. Лишний запрос молча ничего не присылает. Если письмо не пришло, сначала проверить 4.4 (m) для тестового аккаунта и не повторять чаще.
   - по остальным правкам — проверки из итогового отчёта раунда.
6. Только после этого — раздел 9, условия пула.

## 11. Откат

Порядок важен. Новый код останавливает ночной добор через `refill_paused_at`: так работают отмена клиентом, пауза по ёмкости и пауза по расходу. Старый крон (`autoPipeline.ts` до ENG) берёт все конфиги с `enabled = true` и паузу не читает. Значит, после отката он в 03:20 UTC каждую ночь купит сборы для всех включённых ENG-конфигов, в том числе отменённых, и без проверок Do-not-contact, блокировок и потолков. Поэтому сначала шаги 11.1 и 11.2, потом код.

### 11.0 Что откатываем **[«да»]**

- **Вариант А, целиком.** `git revert -m 1 a6315091c` — слияние test → main (#2931). Если к тому времени в `main` уже есть второй выкат, сначала откатить его слияния, от новых к старым.
  - Вместе с ENG уходят чужие коммиты: VE2 `02b884f84`, `d13e10fbe`, `e991995f2`, `031992c21`.
  - Заметка VE2 запрещает откатывать код на версию, которая не читает сохранённые условия аудиторий. Перед вариантом А проверить:

    ```sql
    begin read only;
    select count(*) from public.ve_hypotheses where audience_scope is not null;
    rollback;
    ```

    Если не 0 — вариант А только с согласия автора VE2.
- **Вариант Б, только ENG.** Отдельная ветка, приготовленная заранее, не во время аварии:
  1. Откатить ENG-коммиты поверх порта, от новых к старым: раунд правок, `031992c21`.
  2. Затем `git revert -m 2 40d17e0b3`. У `40d17e0b3` первый родитель — ENG (`222987cb1`), второй — Sergey (`46bd0e82e`). `-m 2` оставляет сторону Sergey и убирает ENG.
  3. Вероятны конфликты: например, `e991995f2` правили поверх слияния ENG. Гейты на такой ветке прогнать до выката.

### 11.1 Выключить ночной добор ENG **[«да»]**

Делается **до** слияния отката. Один из двух способов.

**Через БД** (точечно, обратимо). Список id сохраняется в файл на хосте:

```sh
docker exec -i main-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -At -c "
update public.he_auto_pipeline_configs c
   set enabled = false, updated_at = now()
  from public.he_projects p
 where p.id = c.project_id and p.market = 'us' and c.enabled
returning c.project_id;" > /root/eng-rollback-refill-ids-$(date -u +%Y%m%d%H%M).txt
```

**Через crontab** (останавливает весь крон `heAutoPipelineCron`):
1. `crontab -l > /root/crontab.bak-$(date -u +%Y%m%d%H%M)`.
2. `crontab -e`, поставить `#` перед строкой `20 3 * * * docker exec portal-worker-hypothesis-engine node /app/workers/heAutoPipelineCron.js …`.

### 11.2 Поставить ENG-кампании на паузу вручную **[«да»]**

В старом коде нет ни паузы ENG-клиента, ни остановки по блоку. Список кампаний:

```sql
begin read only;
select p.id as project_id, p.name,
       coalesce(c->>'campaign_id',   t.launch_info->>'campaign_id')   as campaign_id,
       coalesce(c->>'campaign_name', t.launch_info->>'campaign_name') as campaign_name
  from public.he_templates t
  left join public.he_verticals v on v.id = t.vertical_id
  left join public.he_bases b on b.id = t.base_id
  join public.he_projects p on p.id = coalesce(v.project_id, b.project_id)
  left join lateral jsonb_array_elements(
         case when jsonb_typeof(t.launch_info->'campaigns') = 'array'
              then t.launch_info->'campaigns' else '[]'::jsonb end) c on true
 where p.market = 'us'
   and coalesce(t.launch_info->>'campaign_id', '') <> ''
 order by p.id;
rollback;
```

Каждую кампанию поставить на паузу в Instantly, в workspace пула: `HE_US_POOL_WORKSPACE`, если задан, иначе `account-2`. Сохранить список того, что поставили на паузу. Пока пул пуст (раздел 9), список, скорее всего, пустой.

### 11.3 Код **[«да»]**

Порядок:
1. Revert (11.0).
2. Пуш в Sergey.
3. Sergey → test → main.
4. «Run Now».

Выкат снова полный, окна те же (раздел 7). Строка памяти воркера в compose и `NODE_OPTIONS` откатываются вместе.

### 11.4 Чего не трогать

- **Схему.** Старый код работает поверх всех 24 миграций с 14.10, а миграции раунда обязаны быть безопасны для старого кода.
- **`HE_ENG_AUTO_LAUNCH=0`** оставить.
- **Строки `HE_US_*` в `.env`.** Старый код их не читает, они не мешают.
- **Новые таблицы.** Не удалять.

### 11.5 Что будет после отката

**Остаётся:**
- баны GoTrue;
- `MAIN_DISABLE_SIGNUP`, если ставили;
- исправленный триггер регистрации, если его применили.

**Пропадает:**
- гейт подтверждения почты;
- лимит регистраций с одного IP;
- проверки Do-not-contact ENG;
- потолки расходов;
- пауза и блок ENG;
- если откатывали и второй выкат:
  - сброс пароля ENG ссылкой (снова новый пароль в письме);
  - отказ ENG-аккаунтам в запуске кампаний, оплате тарифа и отправке через свои ящики;
  - остановка платного исследования на почти пустом сайте: клиент ENG снова получает исследование, построенное без текста сайта и без описания, а кнопка «Save and continue» пропадает. Проект, остановленный этой правкой (`website_thin`), старый код считает обычным сбоем, и «Try again» начинает исследование заново;
  - защита чтения сайтов в `polzaOutreach`: авторассыльщик снова читает внутренние адреса, любые порты и страницы целиком;
  - снятие адресов Do-not-contact с идущих кампаний, если `HE_ENG_DNC_REMOVE` включали. Таблицы `he_eng_dnc_*` остаются (11.4), ждущие в них строки никто не исполняет.

**Возвращается:** ошибка 500 «duplicate key…» на двойной клик в инструменте гипотез и в кабинете.

### 11.6 Вернуться вперёд **[«да»]** на каждый пункт

После повторного выката нового кода:
1. Включить обратно конфиги из файла 11.1:

   ```sql
   update public.he_auto_pipeline_configs set enabled = true, updated_at = now()
    where project_id in (<id из файла>);
   ```

   Кроме проектов аккаунтов, которые за это время заблокировали.
2. Если в 11.1 комментировали crontab, раскомментировать строку.
3. Снять с паузы кампании из списка 11.2, кроме тех, что клиент или сотрудник за это время остановили сами.

## Приложение А. Что заметят сотрудники RU

Владелец отвечает по каждому пункту: оставляем или выключаем для русских проектов (#4).

1. **Английские цепочки и шаблоны русских проектов** пишутся по-новому:
   - ровно 4 письма; если модель дала 3, бывает лишний платный повтор;
   - приветствие без имени;
   - в промпте нет роли агентства;
   - в примере письма вымышленные компании (Vandelay, Hooli), и для русских проектов их никто не ловит;
   - на шаге 5 появляется жёлтый блок «Предупреждения регламента писем».

   Русские и польские письма не меняются.
2. **Шаг 1:** оффер длиннее 3000 символов не сохраняется. Ошибка «offer_override: максимум 3000 символов», счётчика в поле нет.
3. **Сайт клиента не открывается:** ошибка «Сайт клиента недоступен (dns|no_html): …». Если заполнено ручное описание бизнеса, исследование идёт по нему.
4. **Короткие сбои модели или поиска** повторяются через 60 и 120 с, а не примерно через 5. Такие стадии идут дольше.
5. **Сбор базы:** дочерний сбор ждёт в очереди до 10 ч и работает до 3 ч. Ночь может быть длиннее.
6. **Пустой список типов компаний или должностей**, а также полный отказ поиска останавливают стадию с ошибкой.
7. **Запуск шаблона сотрудником:**
   - чёрный список клиента не прочитался — отказ 500;
   - все адреса в чёрном списке — отказ 400;
   - сегментный запуск, упавший на середине, выглядит как «Кампания создана», без кнопки дозапуска.
8. **Шаблон, поставленный на пересборку прямо перед деплоем,** может вернуть старые письма.
9. **В инструменте гипотез** появляются карточка «Пул ящиков ENG» и запрос паузы добора. Русские проекты это не блокирует.
10. **Админка пользователей:**
    - английские клиенты скрыты по умолчанию;
    - есть карточка «Английские клиенты»;
    - если профиль не прочитался, действия над русскими клиентами отвечают 500 «Не удалось проверить…».
11. **Страница ящиков русского клиента:** редкие ошибки 500 приходят английским текстом.
12. **Деплой полный:** до ~45 мин портал в режиме обслуживания, а VE2, ручной скоринг и автопайплайн стоят.
13. **Память воркера гипотез:** 2 ГБ вместо 512 МБ на общем сервере.
14. **Если SMTP зависнет,** задачи инструмента гипотез могут стартовать на минуты позже: перед каждой задачей воркер рассылает письма английским клиентам.
15. **В чате health-бота** появятся ENG-алерты. Возможен ложный оранжевый «ENG ночной добор …», см. 6.1.
16. **Деньги:** пока не заданы лимиты и отдельные ключи (6.1), английский кабинет тратит баланс Requesty и Serper, общий с русскими базами.

Русских клиентов этот аудит не затрагивает: кабинет, вход, регистрация и рассылки по его коду не меняются. VE2 по коду ENG-порта тоже не меняется. Оговорка: VE2-коммит `02b884f84`, который едет в том же `main`, аудит не проверял.

## Приложение Б. Ссылки из кода на этот документ

- `supabase/migrations/20261010_0001_he_eng_paid_access.sql` → «шаг 4 заметок выката» = раздел 8.8 (бэкфилл подтверждений почты).
- `app/src/lib/hypothesisEngine/engClientSpend.ts` → «заметки выката, шаг 8» = раздел 6.2 (расход без проекта).
- Смена сайта ENG-клиента — отдельный документ: [`eng-change-client-website.md`](./eng-change-client-website.md).
