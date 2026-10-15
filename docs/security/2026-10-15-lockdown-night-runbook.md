# Ночь 15.10.2026: ручное применение lockdown 20261015_0030…0036

Серия из семи миграций закрывает чтение `profiles`, таблицы без RLS, открытые политики,
приватные бакеты и definer-функции. Сегодня ночью её применяем руками, а не деплоем:
тот же порядок и та же семантика, что у раннера `app/scripts/db/ensureDatabase.js`, но
с остановленными воркерами и с репетицией перед применением. Код серии поедет позже
через Sergey. Текущий прод-код с новой базой работает (эмуляция P4 и смоук): сотрудники
видят то же, что и раньше, клиенты видят только своё.

Каждый шаг с записью в прод (остановка воркеров, репетиция, применение, запуск воркеров,
откат) делается только после явного «да» владельца (AGENTS.md). Шаги только на чтение
помечены «чтение».

## Что где лежит

| Файл | Что делает |
|---|---|
| `supabase/operator-sql/20261015_lockdown_rehearsal.sh` | Проверяет готовность, затем прогоняет все ещё не применённые файлы и смоук в одной транзакции и откатывает её. Пишет отметку `rehearsal-ok`. |
| `supabase/operator-sql/20261015_lockdown_apply.sh` | Применяет файлы как раннер: каждый в своей транзакции вместе со строкой в `portal_migrations`. Без `--yes` только показывает план. |
| `supabase/operator-sql/20261015_lockdown_smoke.sql` | Проверки только на чтение: каталог, пробы от лица сотрудника, клиента, робота, anon и service_role, отпечаток политик и прав. Тот же файл проверяет Instantly DB. |
| `supabase/operator-sql/20261015_00XX_*.rollback.sql` | Откат каждого файла. |

У скриптов общие коды выхода: 0 — успех, 1 — ошибка окружения, 2 — проверка
готовности отказала (ничего не записано), 3 — упал файл, 4 — упал смоук на репетиции.
При коде 4 всё откатилось.

Что скрипты проверяют перед запуском (отказ, код 2):
- нет ни одного запущенного контейнера `portal-worker-*`;
- нет чужих транзакций старше 3 с;
- на таблицах `public` и `storage` нет очереди блокировок и сильных блокировок;
- нет VACUUM, который не уступит блокировке (анти-wraparound или ручной);
- не идёт `pg_dump`;
- подключение идёт под суперпользователем `postgres`, сервер PostgreSQL 15.

Без отказа, но с предупреждением скрипты показывают две вещи. Первая: в
`portal_migrations` есть файлы новее серии, то есть каталог менялся после тестов. «Новее»
значит одно из двух: имя идёт после `20261015_0036`, или строка записана позже
`LK_LEDGER_SINCE` (по умолчанию `2026-10-15 13:03:00+00`; последняя строка журнала
на момент тестов — 13:02:33 UTC). Второе ловит и миграцию того же дня с номером
`0013…0029`, которую сравнение по имени пропустило бы. Вторая вещь: в репозитории есть
миграции, которых нет в `portal_migrations`.

`apply.sh --yes` дополнительно требует успешную репетицию тех же байтов не старше 6 часов
(файл `$LK_LOG_DIR/rehearsal-ok`).

## 0. Окно и запреты

- **Окно: 20:00–21:00 UTC (23:00–00:00 МСК).** Дренаж начинаем в 19:50 UTC.
- **Вечерний бэкап main DB — единственная свежая точка восстановления перед правкой.**
  Он стартует в 18:00 UTC и идёт долго. 14.10 было так:
  - `pg_dump` и упаковка шли с 18:00 до 19:07 UTC;
  - `Dump complete` для `portal-main-main-full-…_180000.tar` появился в 19:09 UTC;
  - выгрузка в S3 шла до 19:58 UTC.

  Пока идёт `pg_dump`, проверка готовности отказывает. Выгрузка в S3 читает только
  файл, базу не трогает. Готовность дампа проверяем на шаге 1.6, до дренажа.
- Остальное рядом таблицы не держит:
  - крон portal-mirror (читает main DB) идёт в 22:00 UTC;
  - крон tg-transcribe в 19:00 UTC только ставит задачи, это секунды;
  - синк instantly-dataset в 21:00 UTC читает только Instantly DB.

  Задач `pg_cron` в main DB нет (проверено 15.10).
- **Во время окна никаких мержей в `main` и деплоев.** Деплой поднимет остановленные
  воркеры и сам запустит раннер миграций.
  - До окна проверь, что деплой не идёт.
  - `cat /home/Portal/prod/last_deploy_sha` должен показать `7c3771c0f…`, как 15.10 в
    15:00 UTC, или `96462405d…`. Это `main` на 16:05 UTC: лендинг outreachos.xyz, язык
    в demo-lead, телеметрия VE2. Миграций в нём нет, БД он пишет через `service_role`,
    поэтому покрытия серии он не меняет (проверено 15.10 в 16:20 UTC). Любой другой sha —
    сначала разобрать, что приехало, и прогнать блок 1.2б.
- Предупреди команду и тестировщиков:
  - с 19:50 до ~20:30 UTC стоят все фоновые задачи: парсеры, конструктор баз, движки,
    TG-аутрич, скоринг;
  - на время репетиции и применения портал подвисает, в норме на секунды;
  - запросы к закрываемым таблицам ждут, пока скрипт держит блокировки.
- **Пока держатся блокировки, REST может отвечать 504 всем, а не только порталу.**
  У `main-rest` пул из 30 соединений (`PGRST_DB_POOL=30`), соединение ждут 10 с
  (`PGRST_DB_POOL_ACQUISITION_TIMEOUT=10`). Middleware читает `profiles` на каждой
  странице, поэтому такие запросы встают в очередь за блокировкой и занимают пул. Когда
  заняты все 30 соединений, любой REST-вызов через 10 с получает 504. Это касается и нод
  сендера: они делают 500–1000 вызовов в минуту с ключом service_role (`HEAD
  sender_messages`, `PATCH sender_mailboxes`, `rpc/claim_sender_messages`,
  `rpc/sender_acquire_lease`). Таблицы `sender_*` серия не блокирует, но пул общий.
  Так уже бывало: 15.10 в 14:00 UTC ноды получили 18 ответов 504 за одну минуту.
  Поэтому:
  - предупреди того, кто ведёт сендер: около 20:00–20:15 UTC возможны 504 в течение
    десятков секунд, ноды должны их переждать;
  - не держи блокировки дольше нужного: порог отмены на шагах 3 и 4 — **45 секунд**;
  - на шаге 8 проверь ответы нодам сендера.
- Отдельно предупреди владельцев ключей Bench API. После применения и до выхода кода
  через Sergey (раздел 10) поиск роботов в `company-base` **по названию** будет
  упираться в таймаут 120 с:
  - текущий прод-код ищет `ilike` прямо по `pdl_companies` (19,6 млн строк);
  - под фильтром 0033 такой запрос не может взять триграммный индекс;
  - поиск без названия и остальные инструменты Bench работают как раньше.

  Роботы не простаивают. За 30 дней 2 ключа сделали 4 677 вызовов, из них 43 —
  поиск `company-base` (в среднем 5,4 с). Последний вызов был 05.10. Счётчик
  входов в preflight 0030 (P6) показывает у роботов 0, потому что их токены выпускаются
  без входа. Реальную нагрузку показывает P6b.
- На время остановки воркеров health-check может прислать в TG алерты. Это ожидаемо.

## 1. Подготовка на Mac (до 19:50 UTC)

Все команды ниже выполняются **в bash**. В zsh переменная `$LK_PSQL` не разбивается на
слова, поэтому сначала набери `bash`. Чтобы Mac не уснул, запускай длинные шаги через
`caffeinate -i`.

```bash
bash
cd /Users/cybermart/Desktop/Portal-Mac-Transfer-2026-09-06-Updated/Portal/codex-worktrees/profiles-lockdown
git log -1 --format='%H %s'          # коммит, с которого применяем; записать

export SSH_PROD="ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -i /Users/cybermart/.ssh/portal_hostkey_mac_ed25519 root@139.60.162.24"
export LK_PSQL="$SSH_PROD docker exec -i main-postgres psql -U postgres -d postgres"
# То же, но сессия read only на уровне сервера: для смоука и проверок.
export LK_PSQL_RO="$SSH_PROD docker exec -e PGOPTIONS=-cdefault_transaction_read_only=on -i main-postgres psql -U postgres -d postgres"
export LK_DOCKER="$SSH_PROD docker"
export LK_LOG_DIR="$HOME/lockdown-night-20261015"
mkdir -p "$LK_LOG_DIR"
$SSH_PROD 'printf SSH_OK; cat /home/Portal/prod/last_deploy_sha'
```

**1.1. Байты серии (чтение).** Байты должны совпасть с проверенными (прогон
coverage-1015 и ночные тесты):

```bash
shasum -a 256 supabase/migrations/20261015_003{0_profiles,1_staff,2_no_rls,3_open,4_rls_tables,5_storage,6_anon}*.sql
```
```
5cea3779f9df33c43d250abe0230c092edc6f8597b83e92d06ffa1cf2702561b  …0030_profiles_read_lockdown.sql
b80c70d993b4a8bd0c685fa65ea8929529c405689a3f0a667ccd45db6a4648a7  …0031_staff_gate_helpers.sql
d6352cdcb4cc02ca5d2fa83915e250205a376b8560916c8026550c34fc7816e5  …0032_no_rls_tables_lockdown.sql
9f42d78dbcfddf9eb57d8f75908444a824a1024233234178a5f45f05562e6e29  …0033_open_policies_staff_gate.sql
dec7a7ffbbb6a9974e274d09afaa43209bb522c24713afe13018bb53a58812b4  …0034_rls_tables_staff_or_own_gate.sql
fe1a017814e9bdbf4387b46c7febb5de8804e60653ffd0562717228ae38ec8bf  …0035_storage_private_buckets_gate.sql
5227dcc2d9d6dfa91361be643488a7f125a97a237dbf121b413e9ea648cc12af  …0036_anon_definer_view_lockdown.sql
```
Не совпало — стоп. Значит, файлы правили после тестов.

**1.2. Снимок «до» и проверка, что каталог прода не менялся после тестов (чтение).**
```bash
$LK_PSQL_RO -X -q -At -v ON_ERROR_STOP=1 < supabase/operator-sql/20261015_lockdown_smoke.sql \
  > "$LK_LOG_DIR/smoke-before.out" 2> "$LK_LOG_DIR/smoke-before.err"
grep -o 'SMOKE|fingerprint.*' "$LK_LOG_DIR/smoke-before.err"
```
До применения смоук и должен падать (код 3): много `FAIL`, это ожидаемо. Важна строка
`fingerprint`. 15.10 в ~15:00 UTC она была такой:
```
policies 574 (permissive 574, restrictive 0) md5 3cd4a386cc06d33d60a6c3913a03370c | acl md5 fe7c00e33ac131d6d27e04fdb035436f | functions md5 9f0c5b567c892ef8d3c771e668e5164d
```
Если md5 другой, после тестов были деплой или ручная правка. Тогда сначала надо понять, что
изменилось: `grep -E '^(POLICIES|ACL|FN)\|'` из этого файла сравнить со снимком
`night/prod-ro/smoke-main-pre.out` в scratchpad. Если изменились политики или права
таблиц серии, эмуляцию P4 нужно перепрогнать (`map/coverage-1015/prod-sync.mjs`).

**1.2б. Журнал и каталог после тестов (чтение).** У отпечатка выше есть слепые зоны. Он
не видит изменённое выражение политики с прежним именем и изменённое тело функции. Ещё он
не видит миграцию того же дня, если она ничего не добавила. Этот блок закрывает их:
```bash
$LK_PSQL_RO -X -q -At -v ON_ERROR_STOP=1 <<'SQL'
begin read only;
select 'ledger-after-tests|' || count(*) || '|' || coalesce(string_agg(name, ' ' order by applied_at), '-')
  from public.portal_migrations where applied_at > '2026-10-15 13:03:00+00';
with tip as (select age(xmin) a from public.portal_migrations order by applied_at desc limit 1)
select 'catalog-after-ledger|' || (select count(*) from pg_class c, tip where c.relnamespace in ('public'::regnamespace, 'storage'::regnamespace) and age(c.xmin) < tip.a)
       || '|' || (select count(*) from pg_proc p, tip where p.pronamespace = 'public'::regnamespace and age(p.xmin) < tip.a)
       || '|' || (select count(*) from pg_policy p, tip where age(p.xmin) < tip.a);
select 'policy-expr|' || count(*) || '|' || md5(string_agg(p.polrelid::regclass::text || '|' || p.polname || '|' || p.polcmd::text || '|'
       || p.polpermissive::text || '|' || p.polroles::text || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|'
       || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), E'\n' order by p.polrelid::regclass::text, p.polname))
  from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace in ('public'::regnamespace, 'storage'::regnamespace);
select 'function-body|' || count(*) || '|' || md5(string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|'
       || coalesce(array_to_string(p.proconfig, ','), ''), E'\n' order by p.oid::regprocedure::text))
  from pg_proc p where p.pronamespace = 'public'::regnamespace;
rollback;
SQL
```
15.10 в 16:09 UTC было так:
```
ledger-after-tests|0|-
catalog-after-ledger|0|0|0
policy-expr|574|d16b7029414b6a5d7e390ac8f5f5c958
function-body|480|7893f525049fa7dd5836d87dc7e8322e
```
Как читать:
- `ledger-after-tests` не 0: после тестов прошёл деплой с миграциями. Скрипты покажут то
  же предупреждением `newer`. Прочитай эти файлы. Новая SECURITY DEFINER-функция,
  которую браузер зовёт с JWT пользователя, после 0036 потеряет право вызова. Новая
  таблица или политика может требовать прогона P4.
- `catalog-after-ledger` не `0|0|0`: каталог правили руками, не миграцией. Какие строки
  изменились, покажет этот запрос:
  ```bash
  $LK_PSQL_RO -X -q -At -v ON_ERROR_STOP=1 <<'SQL'
  begin read only;
  with tip as (select age(xmin) a from public.portal_migrations order by applied_at desc limit 1)
  select 'class|' || c.oid::regclass::text || '|' || c.relkind::text from pg_class c, tip where c.relnamespace in ('public'::regnamespace, 'storage'::regnamespace) and age(c.xmin) < tip.a
  union all select 'function|' || p.oid::regprocedure::text || '|' from pg_proc p, tip where p.pronamespace = 'public'::regnamespace and age(p.xmin) < tip.a
  union all select 'policy|' || p.polrelid::regclass::text || '|' || p.polname from pg_policy p, tip where age(p.xmin) < tip.a;
  rollback;
  SQL
  ```
  Одна-две строки `class|` у таблиц данных при неизменных отпечатке 1.2 и `policy-expr`
  обычно значат TRUNCATE или REINDEX: у таблицы новый файл, права не менялись. Это не
  стоп.
- Другой md5 у `policy-expr` или `function-body`: выражение политики или тело функции
  изменились.

Любое другое отклонение — стоп до разбора: серию не применяют к каталогу, который не
проверяли. Блок быстрый, его стоит повторить на шаге 2.4, прямо перед репетицией.

Тем же файлом снимок Instantly DB (чтение):
```bash
$SSH_PROD docker exec -i instantly-postgres-prod psql -U instantly -d instantly -X -q -At -v ON_ERROR_STOP=1 \
  < supabase/operator-sql/20261015_lockdown_smoke.sql 2>&1 | grep -o 'SMOKE|.*'
```
Ждём `I1 … PASS`, `I2 … PASS` и `summary|PASS`. Таблица `client_reply_telegram_links`
(«получать ответы в Telegram») живёт здесь, и серия эту базу не трогает.

**1.3. Готовые preflight серии (чтение).**
```bash
$LK_PSQL_RO -X -v ON_ERROR_STOP=1 < supabase/operator-sql/20261015_lockdown_preflight.sql > "$LK_LOG_DIR/preflight.out" 2>&1
$LK_PSQL_RO -X -v ON_ERROR_STOP=1 < supabase/operator-sql/20261015_0030_profiles_read_lockdown.preflight.sql > "$LK_LOG_DIR/preflight-0030.out" 2>&1
```
Ожидания написаны в каждом блоке. Важное:
- Q3: нет LOGIN-ролей без bypassrls, наследующих anon или authenticated;
- Q5: 0 демо-сотрудников;
- Q8: все `present = t`;
- Q10: 0 строк;
- P6b (в `preflight-0030.out`): вызовы роботов Bench за 30 дней. Если `company-base`
  ищет часто, предупреди владельцев ключей (раздел 0).

**1.4. Базовая статистика nginx (чтение)**, чтобы потом сравнить:
```bash
$SSH_PROD "tail -n 50000 /var/log/nginx/access.log | awk '\$7 ~ /^\/(rest|storage)\/v1|^\/api\// {print \$9}' | sort | uniq -c | sort -rn | head" | tee "$LK_LOG_DIR/nginx-before.txt"
# то же только для нод сендера
$SSH_PROD "tail -n 50000 /var/log/nginx/access.log | awk '\$7 ~ /^\/rest\/v1\/(rpc\/)?(sender_|claim_sender_messages)/ {print \$9}' | sort | uniq -c | sort -rn" | tee "$LK_LOG_DIR/nginx-sender-before.txt"
```
15.10 в 16:10 UTC у сендера были только 200, 204, 201 и 206.

**1.5. Проверка готовности (чтение).** Скрипт откажет из-за запущенных воркеров, это
ожидаемо:
```bash
bash supabase/operator-sql/20261015_lockdown_rehearsal.sh --check; echo "exit=$?"
```
Ждём в выводе:
- `db: postgres|true|15.8`;
- `to apply, in this order:` и семь файлов;
- нет предупреждений `newer` и `other repo migrations`;
- `exit=2`, причина — только воркеры, иногда ещё короткие транзакции.

15.10 в 14:56 UTC так и было.

**1.6. Вечерний дамп готов (чтение, 19:15–19:45 UTC).** Без него дренаж не начинаем:
```bash
$SSH_PROD 'docker logs --timestamps --since 3h portal-backup 2>&1 | grep -E "main-full|instantly-full|S3 upload OK" | sed -E "s#https://[^ ]+#<s3>#"'
$SSH_PROD 'docker exec portal-backup ls -l /backups/portal-main-main-full-20261015_180000.tar'
```
Ждём строку `Dump complete: /backups/portal-main-main-full-20261015_180000.tar (…
bytes)`, размер около 13,4 ГБ, как 14.10, и файл в `ls`. Это и есть точка
восстановления. Строки `Uploading to S3` без `S3 upload OK` после неё значат, что
выгрузка ещё идёт. Это не помеха: она читает файл, а не базу. Её конец
(`Done. … main-full retained`) дописываем в итог ночи.

Если к 19:45 UTC строки `Dump complete` для `…20261015_180000` нет, дренаж не начинаем
и зовём владельца. Возможны два случая:
- `pg_dump` ещё идёт: проверка готовности всё равно откажет, окно сдвигается;
- в логе ошибка: свежей точки восстановления нет. Идти без неё можно только с явного
  «да» владельца, и тогда точка восстановления — утренний `…20261015_060000.tar`.

**1.7. Конфигурация воркеров (чтение, перед 19:50 UTC).** Шаг 6 запускает ровно те
контейнеры, что были остановлены, с их прежней конфигурацией. Этот шаг показывает, что
изменилось бы, если бы их пересоздали из нынешних compose и `.env`. Ночью мы этого не
делаем, но владелец должен видеть расхождение. Запусти скрипт из приложения А:
```bash
$SSH_PROD python3 - < "$LK_LOG_DIR/worker-drift.py" | tee "$LK_LOG_DIR/worker-drift.txt"
```
Скрипт печатает только имена переменных, значений не показывает. 15.10 в 16:10 UTC было
так (контейнеры созданы деплоем в 13:03 UTC, `.env` правили в 13:11 UTC, после этого
пересоздавали только enrich):
```
46 service(s): worker-aicaller … worker-yandexmaps
    config-hash DIFFERS
    only in the running container: TA_SCORING_JEV_SURFACES
    only in compose/.env now: -
    value differs: -
9 service(s): worker-enrich worker-enrich-2 … worker-enrich-9
    config-hash same
    …
```
Как читать другой вывод:
- одна группа `55 service(s)` с `config-hash same` и прочерками: до окна прошёл деплой.
  Он пересоздаёт все воркеры с нынешним `.env`, расхождения больше нет. Это нормально;
- новые имена, другие сервисы или непустой `value differs`: `.env` или compose правили
  ещё раз. Ночью это ничего не меняет, потому что шаг 6 не пересоздаёт контейнеры. Но
  сообщи владельцу: эти правки доедут до воркеров со следующим деплоем.

## 2. Остановка воркеров (19:50 UTC, запись — после «да»)

### 2.1. Какие воркеры есть и что они делают

На проде 55 контейнеров `portal-worker-*`, по одному на сервис `worker-*` в
`docker-compose.prod.yml`. Все ходят в main DB под `service_role` (PostgREST) или
прямым пулом. Они держат транзакции и блокировки на тех самых таблицах, которые серия
берёт ACCESS EXCLUSIVE. Длинные RPC каталога у VE2 и HE идут до 180 с, и фаза
блокировок 0032–0034 (30 с) с ними не уложится.

| Контейнер | Что делает | Как останавливается |
|---|---|---|
| `portal-worker-vertical-engine-v2` | Движок вертикалей v2: сбор и подготовка баз | `drain-worker.sh`, мягко, до 5 мин |
| `portal-worker-hypothesis-engine` | Движок гипотез (ENG-кабинет и RU-инструмент), `he_jobs` | drain, мягко, по StopTimeout контейнера (около 5 мин) |
| `portal-worker-manual-scoring` | Ручной скоринг клиентских баз | drain, мягко, до 10 мин |
| `portal-worker-autopipeline` | Автопайплайн доменов | drain, мягко, до 20 мин |
| `portal-worker-hh` | Парсер HH, внутри него крон OutreachOS (05:15 МСК) | drain: очереди на паузу, `docker stop -t 15` |
| `portal-worker-eng-hiring` | Англоязычный найм, крон jobhive (16:30 МСК) | drain, `-t 15` |
| `portal-worker-polza-outreach` | Аутрич Polza RU | drain, `-t 15` |
| `portal-worker-search` | Поисковый парсер | drain, `-t 15` |
| `portal-worker-enrich` | Обогащение сайтов, первая реплика | drain, `-t 15` |
| `portal-worker-enrich-2` … `-9` | Реплики обогащения | compose stop |
| `portal-worker-enrich-coordinator` | Координатор обогащения | compose stop |
| `portal-worker-yandexmaps` | Яндекс.Карты | drain, `-t 15` |
| `portal-worker-googleparsers` | Google Maps и News | compose stop |
| `portal-worker-emailvalidation` | Валидация email | drain, `-t 15` |
| `portal-worker-inn-enrich` | Обогащение по ИНН | compose stop |
| `portal-worker-website-inn-lookup` | Поиск ИНН по сайтам | compose stop |
| `portal-worker-tg-outreach` | TG-аутрич: кампании на паузу, задачи автостарта в очередь | drain, `-t 15` |
| `portal-worker-aicaller` | AI-звонки: так же, пауза и автостарт | drain, `-t 15` |
| `portal-worker-tg-transcribe` | Транскрибация TG, крон в 22:00 МСК | drain, `-t 15` |
| `portal-worker-outreach` | Аутрич (письма) | drain, `-t 15` |
| `portal-worker-baseconstructor`, `-2` … `-12` | Конструктор баз, 12 реплик | drain: `-t 5`, задачи помечаются на немедленное продолжение |
| `portal-worker-sales-copilot` | Копилот продаж | compose stop |
| `portal-worker-sales-ai-analysis` | AI-анализ сделок, крон 03:30 МСК | compose stop |
| `portal-worker-sales-chat-logger` | Лог чатов продаж | compose stop |
| `portal-worker-sales-chat-archive` | Архив чатов продаж | compose stop |
| `portal-worker-leads-report` | `sleep infinity`, контейнер для крона отчёта (18:15 МСК) | compose stop |
| `portal-worker-leads-report-bot` | TG-бот отчётов по лидам | compose stop |
| `portal-worker-handoff-check-bot` | TG-бот проверки передач лидов | compose stop |
| `portal-worker-sender-leads` | Лиды сендера | compose stop |
| `portal-worker-byo-send` | Отправка с BYO-ящиков | compose stop |
| `portal-worker-byo-replies` | Ответы с BYO-ящиков | compose stop |
| `portal-worker-client-report-exports` | Выгрузки клиентских отчётов, прямой пул к БД | compose stop |
| `portal-worker-tg-parser` | TG-парсер | compose stop |
| `portal-worker-li-outreach` | LinkedIn-аутрич | compose stop |
| `portal-worker-instantly-leads` | Синк лидов Instantly | compose stop |
| `portal-worker-bob-scorer` | Фоновый скоринг | compose stop |
| `portal-worker-autorenew` | Автопродление | compose stop |

**Кого можно оставить.** Безвреден только `portal-worker-leads-report`: в нём
`sleep infinity`, соединения с БД нет. Все остальные открывают транзакции на таблицах
серии. Рекомендация — останавливать все 55: скрипты это проверяют, исключений не
нужно. Если владелец решит оставить leads-report, перед шагами 3–4 сделай
`export LK_KEEP_WORKERS=portal-worker-leads-report`.

Остальные сервисы не трогаем:
- `portal` и стек `main-*`;
- health-check, loop-watchdog, instantly-sync-bot, portal-external-sync;
- atmos-bot, changelog-bot, polza-reports, transcribe-worker, yandexmaps, googleparsers.

Они делают короткие запросы. Если какой-то из них держит длинную транзакцию, проверка
готовности её покажет (шаг 2.4).

### 2.2. Дренаж

**Сначала снимок запущенных воркеров (чтение).** Без него шаг 6 не сделать: он
запускает ровно этот список. Снимок делается **один раз**, до первого дренажа. Если
дренаж придётся повторить, старый снимок не перезаписывай, иначе из него выпадут уже
остановленные воркеры. Команда ниже сама откажется перезаписывать:
```bash
if [ -e "$LK_LOG_DIR/workers-before.txt" ]; then echo "СНИМОК УЖЕ ЕСТЬ, не перезаписываю"; else
  $LK_DOCKER ps --format '{{.Names}}' | grep '^portal-worker' | sort > "$LK_LOG_DIR/workers-before.txt"
  $SSH_PROD "docker inspect --format '{{.Name}} {{.Id}} {{.Image}} {{.State.Status}}' $(tr '\n' ' ' < "$LK_LOG_DIR/workers-before.txt")" \
    | sed 's#^/##' | sort > "$LK_LOG_DIR/workers-before.inspect"
fi
wc -l < "$LK_LOG_DIR/workers-before.txt"                                  # ждём 55
wc -l < "$LK_LOG_DIR/workers-before.inspect"                              # столько же
```
В `workers-before.inspect` лежат имя, id контейнера, образ и состояние. Ни
`drain-worker.sh`, ни `compose stop` контейнеры не удаляют, только останавливают:
после шага 6 id должны совпасть.

`drain-worker.sh` без аргументов работает как полный ручной дренаж:
- ставит очереди на паузу (running → pending);
- мягко останавливает VE2, manual-scoring, autopipeline и HE;
- гасит 12 известных контейнеров и реплики конструктора.

Файл на проде совпадает с репозиторием: sha256 `199579e2…` на 15.10.
```bash
$SSH_PROD 'cd /home/Portal/prod && bash drain-worker.sh' 2>&1 | tee "$LK_LOG_DIR/drain.log"; echo "exit=${PIPESTATUS[0]}"
```
Обычно это 2–5 минут. Худший случай около 30 минут, если autopipeline или
manual-scoring заняты. `exit≠0` значит, что одна из мягких остановок не прошла.
Например, manual-scoring не остановился за 10 минут: тогда он нарочно остаётся работать.
Смотри `drain.log` и либо жди и запускай дренаж снова, либо переноси окно.

### 2.3. Остальные воркеры

```bash
$SSH_PROD 'cd /home/Portal/prod && docker compose --env-file .env -p portal -f docker-compose.prod.yml stop -t 60 $(docker compose --env-file .env -p portal -f docker-compose.prod.yml config --services | grep "^worker-")' 2>&1 | tee -a "$LK_LOG_DIR/drain.log"
```
Почему `-t 60`, а не grace из compose. Без `-t` compose ждёт `stop_grace_period`
каждого сервиса: у hh, eng-hiring и polza-outreach это 3 часа, у client-report-exports
2 часа, у нескольких сервисов 30 минут. С `-t 60` контейнер получает SIGTERM и через
минуту SIGKILL. Это мягче, чем каждый деплой (`docker rm -f` в `scheduled-deploy.yml`),
и воркеры такое переживают: задачи подхватываются заново.

### 2.4. Проверка (чтение)

```bash
$LK_DOCKER ps --format '{{.Names}}' | grep '^portal-worker' || echo "воркеров нет"
bash supabase/operator-sql/20261015_lockdown_rehearsal.sh --check; echo "exit=$?"
```
Повторяй `--check`, пока не будет `exit=0`. Если мешает чужая транзакция:
- PostgREST-вызов (authenticator), запущенный воркером до остановки, идёт до 120 с.
  Подожди или отмени его:
  `printf "select pg_cancel_backend(<pid>);\n" | $LK_PSQL -X -At`;
- длинная транзакция у сервиса не из списка (например, portal-external-sync): на время
  окна останови его, `$SSH_PROD docker stop portal-external-sync`, а на шаге 6 запусти,
  `$SSH_PROD docker start portal-external-sync`.

## 3. Репетиция (≈20:00 UTC, запись с откатом — после «да»)

```bash
caffeinate -i bash supabase/operator-sql/20261015_lockdown_rehearsal.sh 2>&1 | tee "$LK_LOG_DIR/rehearsal.console"; echo "exit=${PIPESTATUS[0]}"
```
Что происходит. Одна сессия: `begin`, затем семь файлов по очереди, после каждого
строка в `portal_migrations`. Перед каждым файлом сбрасывается всё, что предыдущий
выставил через SET LOCAL: role, lock_timeout 30s, statement_timeout и search_path по
умолчанию. Затем идёт смоук, затем `rollback`. **Пока идёт репетиция, все блокировки
всех файлов держатся одновременно.** На стенде это 319 таблиц ACCESS EXCLUSIVE и
~1600 записей в таблице блокировок. На проде таблица блокировок вмещает ~7800 записей
(64 × 122), запас большой. Сайт на это время замирает.

Ждём:
- таблицу с временем по каждому файлу и смоуку (на стенде 0,65 с всего; на проде
  дольше, но в пределах секунд: смоук на проде на чтение шёл около 1 с);
- `SMOKE|summary|PASS`;
- `REHEARSAL PASSED and rolled back`.

**Дедлок с живым запросом ожидаем и безвреден.** Репетиция держит `profiles` (0030) и
таблицы 0032 до самого `rollback`, а 0033 и 0034 потом берут ещё и дочерние таблицы
`profiles`: `projects`, `invoices`, `parser_jobs`, `notifications`, `application_logs`,
`client_support_*` и другие. Запрос со страницы, который уже держит такую таблицу и
следом идёт в `profiles`, замыкает цикл. Например:
- INSERT с ненулевой ссылкой на пользователя: проверка FK читает `profiles`;
- выборка service_role со вложенным `profiles(...)`;
- политика RLS с подзапросом к `profiles`, как `application_logs_select_admin`.

Через секунду (`deadlock_timeout`) PostgreSQL снимает одну из сторон. Если это
репетиция, она получает 40P01 и всё откатывается. В применении такого нет: там каждый
файл коммитится отдельно, а порядок блокировок в 0033 и 0034 рассчитан на это. Скрипт
репетиции сам повторяет прогон один раз через 5 с, в выводе это строка
`deadlock (40P01) … Rerun` и затем `attempt 2`.

Рядом в `$LK_LOG_DIR` появятся `rehearsal-ok` и `*-rehearsal.fingerprint`.

**Время каждого файла записать** в итог ночи.

**Стоп-критерии:**
- `exit=2` — проверка готовности, см. 2.4.
- `exit=3` — файл упал, всё откатилось. Ошибки блокировки повторяем:
  - SQLSTATE 55P03 или 57014 в фазе `lock table` (скрипт напечатает `blocker?`):
    найди держателя и повтори репетицию;
  - 40P01 (дедлок) второй раз подряд: снова живой запрос, держатель не нужен,
    повтори репетицию;
  - отмена по порогу ниже (57014, `canceling statement due to user request`): скрипт
    держателя не печатает. Найди его через
    `bash supabase/operator-sql/20261015_lockdown_rehearsal.sh --check`, он покажет
    транзакции старше 3 с и очереди блокировок. Затем повтори.

  Если ошибка другая, **на этом ночь заканчивается**: шаг 6 (запустить воркеры) и разбор.
- `exit=4` — упал смоук на отрепетированном состоянии, всё откатилось. Ночь
  заканчивается: строки `SMOKE|…|FAIL` в выводе, шаг 6, разбор.
- **Порог: 45 секунд.** Если за 45 с после строки `rehearsing … (attempt N)` нет
  таблицы времени, отмени репетицию. Это безопасно в любой момент:
  ```bash
  printf "select pid, pg_cancel_backend(pid) from pg_stat_activity where application_name in ('lockdown-rehearsal','lockdown-apply');\n" | $LK_PSQL -X -At
  ```
  Почему не ждать дольше: пока репетиция держит блокировки, пул `main-rest` забивается,
  и через 10–15 с REST отвечает 504 всем, включая ноды сендера (раздел 0). Ctrl-C в
  терминале не поможет: сервер узнаёт об обрыве клиента только когда закончит текущий
  оператор.

## 4. Применение (сразу после репетиции, запись — после «да»)

```bash
bash supabase/operator-sql/20261015_lockdown_apply.sh            # план: что будет применено, ничего не пишет
caffeinate -i bash supabase/operator-sql/20261015_lockdown_apply.sh --yes 2>&1 | tee "$LK_LOG_DIR/apply.console"; echo "exit=${PIPESTATUS[0]}"
```
Скрипт снова проверяет готовность и отметку репетиции, затем идёт по файлам:
- сессия на каждый файл, `set lock_timeout = '30s'`;
- `begin`, файл, `insert into public.portal_migrations (name)`, `commit`;
- файлы, уже записанные в `portal_migrations`, пропускает;
- ошибку блокировки (55P03, 40P01, 57014 на `lock table`, обрыв связи) повторяет до
  5 раз через 5 с, как раннер. Файл каждый раз откатывается целиком;
- после обрыва связи (код 2 у psql или 255 у ssh) сессия прошлой попытки на сервере
  может дожить и закоммитить файл. Поэтому перед каждым повтором и после упавшего
  повтора скрипт смотрит в журнал. Если строка файла там есть, файл считается
  применённым (`committed by the previous attempt` или `its ledger row exists`), и
  скрипт идёт дальше. Повтор при этом упал бы на 23505 `portal_migrations_pkey`: файлы
  серии можно прогнать повторно, и до вставки в журнал он доходит;
- на любой другой ошибке останавливается;
- в конце шлёт `notify pgrst, 'reload schema'`.

Ждём семь строк `done: file … ms`, таблицу времени и `applied 7 file(s)`, `exit=0`.

**Порог: 45 секунд на файл.** Если после строки `applying … (attempt N)` за 45 с нет
`done:`, отмени тем же запросом, что в разделе 3. Почему так: пока файл ждёт
блокировку или держит её, REST может отвечать 504 всем, включая ноды сендера. Отменённый файл
откатывается целиком. Скрипт отмену не повторяет (57014 без `lock table`) и
останавливается с `exit=3`. Ctrl-C во время файла не поможет: сессия на сервере может
дожить и закоммитить. Во время паузы `retry in 5s` Ctrl-C безопасен, транзакции тогда
нет. Если повторы блокировки идут второй раз подряд на одном файле, это тоже повод
прервать: найди держателя и не морозь сайт по 30 с.

**Если `exit=3`:**
- **Ошибка блокировки после всех повторов, или ты отменил файл по порогу.** Файлы до
  упавшего закоммичены, остальные нет. Найди держателя: после ошибки блокировки скрипт
  напечатает `blocker?`, после отмены запусти `bash
  supabase/operator-sql/20261015_lockdown_apply.sh` без `--yes`. Затем повтори ту же
  команду `--yes`: она пропустит применённые. Отметка репетиции остаётся
  действительной, байты те же.
- **23505 `portal_migrations_pkey` после обрыва связи.** Скрипт этот случай распознаёт
  сам. Если он всё же остановился так, значит, прошлая попытка закоммитила файл. Просто
  повтори `--yes`: файл будет пропущен как применённый. Это не повод для отката.
- **Ошибка не блокировки.** Не повторяй. Частичное состояние безопасно:
  - каждый файл атомарен, и раннер деплоя тоже может так остановиться;
  - по сравнению с тем, что было, закрыто больше, а не меньше;
  - каждый файл сам проверяет, что сотрудники видят то же самое.

  Решение принимает владелец: оставить как есть до разбора или откатить применённые
  файлы (раздел 9). Затем шаг 6.

## 5. Смоук после применения (чтение)

```bash
$LK_PSQL_RO -X -q -At -v ON_ERROR_STOP=1 < supabase/operator-sql/20261015_lockdown_smoke.sql \
  > "$LK_LOG_DIR/smoke-after.out" 2> "$LK_LOG_DIR/smoke-after.err"; echo "exit=$?"
grep -o 'SMOKE|.*' "$LK_LOG_DIR/smoke-after.err"
diff <(grep -E '^(POLICIES|ACL|FN)\|' "$LK_LOG_DIR/smoke-after.out") "$(ls -t "$LK_LOG_DIR"/*-rehearsal.fingerprint | head -n 1)" && echo "итог = репетиции"
$SSH_PROD docker exec -i instantly-postgres-prod psql -U instantly -d instantly -X -q -At -v ON_ERROR_STOP=1 \
  < supabase/operator-sql/20261015_lockdown_smoke.sql 2>&1 | grep -o 'SMOKE|.*'
```
Ждём на main DB `exit=0` и `SMOKE|summary|PASS`. Без `FAIL` должны пройти:
- M1–M12:
  - все 7 файлов в журнале;
  - anon видит ровно `companies_directory`, `database_review_row_marks` и
    `reglament_documents`;
  - authenticated исполняет ровно 21 definer-функцию;
  - RLS включён на всех таблицах `public`;
  - на месте политика `profiles`, шлюзы `storage` и снимок отката 0036;
  - у `service_role` всё как было;
- S1–S5: сотрудник (admin) видит все профили и все строки `projects`, `tasks`,
  `invoices`, `bank_transactions`, `project_periods`, `client_tariffs`. До применения
  эти числа совпадали со счётом суперпользователя: 77, 175, 1759, 31436, 3748, 46, 25;
- C1–C5: клиент видит один свой профиль, ни одной строки сотруднических таблиц, только
  свои `parser_jobs` и запуски скоринга, ни одного чужого файла;
- R1–R3, U1–U3: робот Bench и JWT без профиля;
- A1–A6: anon;
- V1: service_role.

`diff` с отпечатком репетиции должен быть пустым. На Instantly DB ждём `summary|PASS`.

Дополнительно можно прогнать `docs/security/2026-10-15-anon-hotfix/verify.sql`:
- V4 даёт 0 строк;
- V5 даёт **9 строк**: 7 файлов серии и два VE-файла `20261015_0030/0031_ve_*` с тем же
  префиксом.

## 6. Запуск воркеров (запись — после «да»)

Запускаем **те же контейнеры, что были остановлены**, по списку из шага 2.2, через
`docker start`. **Не `docker compose up`.** Причина: 15.10 у 46 из 55 воркеров метка
`com.docker.compose.config-hash` не совпадает с нынешним compose. Деплой создал их в
13:03 UTC, а в 13:11 UTC в `/home/Portal/prod/.env` убрали `TA_SCORING_JEV_SURFACES`,
после чего пересоздали только 9 enrich-воркеров (шаг 1.7). `compose up -d` увидел бы
расхождение и пересоздал бы эти 46 контейнеров с новым `.env`: конструктор баз ×12,
VE2, HE, ручной скоринг, hh, TG-аутрич и другие. Это раскатка конфигурации, которую на
эту ночь никто не проверял, и её не покрывает «да» на запуск воркеров. `docker start`
поднимает контейнер с той конфигурацией, с которой он работал до дренажа. Если до окна
прошёл деплой и расхождения больше нет (шаг 1.7), `docker start` всё равно верный путь.
```bash
$SSH_PROD "docker start $(tr '\n' ' ' < "$LK_LOG_DIR/workers-before.txt")" 2>&1 | tee "$LK_LOG_DIR/start.log"
$SSH_PROD "docker inspect --format '{{.Name}} {{.Id}} {{.Image}} {{.State.Status}}' $(tr '\n' ' ' < "$LK_LOG_DIR/workers-before.txt")" \
  | sed 's#^/##' | sort > "$LK_LOG_DIR/workers-after.inspect"
diff <(cut -d' ' -f1-3 "$LK_LOG_DIR/workers-before.inspect") <(cut -d' ' -f1-3 "$LK_LOG_DIR/workers-after.inspect") \
  && echo "те же контейнеры и образы, ничего не пересоздано"
awk '$4 != "running"' "$LK_LOG_DIR/workers-after.inspect"           # пусто: все запущены
```
В `start.log` должны быть все имена из `workers-before.txt`, по одному на строку.
Задачи, которые дренаж перевёл в pending, воркеры подберут сами. TG- и AI-кампании
стартуют по задачам, которые дренаж поставил в очередь. Если на шаге 2.4 останавливали
сервис не из списка, запусти его сейчас.

**Правку `.env` ночью не раскатываем.** Если владелец захочет, чтобы воркеры получили
нынешний `.env`, это отдельный шаг с отдельным «да»:
1. показать владельцу вывод шага 1.7, снятый перед 20:00 UTC;
2. получить «да» именно на пересоздание перечисленных там сервисов;
3. только потом `docker compose … up -d --no-deps <эти сервисы>`.

По разбору 15.10 сегодняшнее расхождение поведения не меняет. `TA_SCORING_JEV_SURFACES`
читают только конструктор (поверхность `constructor`) и скоринг брифов (`databases`,
он работает только в enrich). Без переменной включены все поверхности, поэтому
конструктор остаётся на Jev. Но это решение владельца, а не побочный эффект ночи. Без
него правка доедет до воркеров со следующим деплоем.

## 7. Проверки снаружи (≈20:25 UTC)

**anon через публичный URL.** Ключ читается на сервере и в терминал не выводится:
```bash
$SSH_PROD bash -s <<'EOF'
ANON=$(grep '^MAIN_ANON_KEY=' /opt/main-db/.env | cut -d= -f2- | tr -d "\"'")
for p in '/rest/v1/profiles?select=id&limit=1' '/rest/v1/rpc/is_internal_staff' '/rest/v1/projects?select=id&limit=1' '/rest/v1/companies_directory?limit=1'; do
  printf '%-50s ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' -H "apikey: $ANON" -H "Authorization: Bearer $ANON" "https://polza-portal.ru$p"
done
EOF
```
Ждём `401` для `profiles`, `rpc/is_internal_staff` и `projects` (permission denied).
`companies_directory` отвечает `200`: это осознанный публичный справочник.

**Сотрудник.** Владелец заходит своим логином и открывает:
- проекты, периоды, задачи;
- команду (план активностей, ревью), платёжные заявки;
- базу компаний: поиск по имени и выгрузку;
- конструктор баз, TG-аутрич, базу знаний.

Везде должны быть те же данные, что днём. Пустой список или «нет доступа» — стоп,
раздел 9.

**Клиент.** Войти тестовым клиентом, не демо, и проверить:
- кабинет со своими данными;
- раздел «получать ответы в Telegram»: статус подключения грузится
  (`GET /api/client/telegram` → 200), ссылка подключения выдаётся
  (`GET /api/client/telegram/link-token` → 200).

Привязки лежат в Instantly DB, их проверил смоук на шаге 5. Профиль клиента роуты
читают через `service_role`.

## 8. Наблюдение 15 минут (до ≈20:45 UTC, чтение)

```bash
# ошибки прав в логах портала и всех воркеров за 15 минут
$SSH_PROD 'docker logs --since 15m portal 2>&1 | grep -iE "permission denied|42501|42P17|infinite recursion|row-level security" | tail -20'
$SSH_PROD 'for c in $(docker ps --format "{{.Names}}" | grep "^portal-worker"); do n=$(docker logs --since 15m $c 2>&1 | grep -ciE "permission denied|42501|42P17|row-level security"); [ "$n" != 0 ] && echo "$c $n"; done; echo checked'
# коды ответов API, сравнить с nginx-before.txt
$SSH_PROD "tail -n 50000 /var/log/nginx/access.log | awk '\$7 ~ /^\/(rest|storage)\/v1|^\/api\// {print \$9}' | sort | uniq -c | sort -rn | head" | tee "$LK_LOG_DIR/nginx-after.txt"
# воркеры живы и берут задачи
$LK_DOCKER ps --format '{{.Names}} {{.Status}}' | grep '^portal-worker' | grep -v ' Up ' || echo "все Up"
# ноды сендера: коды ответов с начала окна (время в логе nginx — МСК, 22:45 МСК = 19:45 UTC)
$SSH_PROD "awk '\$4 >= \"[15/Oct/2026:22:45\" && \$7 ~ /^\/rest\/v1\/(rpc\/)?(sender_|claim_sender_messages)/ {print \$9}' /var/log/nginx/access.log | sort | uniq -c | sort -rn" | tee "$LK_LOG_DIR/nginx-sender-window.txt"
# 5xx у сендера по минутам: когда были и кончились ли
$SSH_PROD "awk '\$4 >= \"[15/Oct/2026:22:45\" && \$7 ~ /^\/rest\/v1\/(rpc\/)?(sender_|claim_sender_messages)/ && \$9 ~ /^5/ {print substr(\$4, 2, 17), \$9}' /var/log/nginx/access.log | sort | uniq -c"
```
Повторить через 5 и через 15 минут. Ещё смотреть health-чат в TG.

У сендера допустимы 504 только в минуты репетиции и применения. После применения
5xx быть не должно, а доля 200/204 должна вернуться к `nginx-sender-before.txt`. Если
5xx идут и после применения, напиши тому, кто ведёт сендер, и проверь, не висит ли
что-то в `main-rest`: `$SSH_PROD 'docker logs --since 15m main-rest 2>&1 | tail -50'`.

**Стоп-критерии** (любой из них — решение владельца по разделу 9):
- смоук после применения не прошёл;
- у сотрудника пропали данные или появилось «нет доступа»;
- в логах портала или воркеров есть 42501, 42P17 или `row-level security` на рабочих путях;
- выросла доля 401/403/5xx на `/rest/v1` и `/api` против `nginx-before.txt`;
- у нод сендера 5xx или 401/403 после применения;
- у клиента не работает статус Telegram.

## 9. Откат

Общие правила:
- Строки в `portal_migrations` **оставляем** (так требует шапка каждого rollback-файла).
  Иначе следующий деплой применит серию снова. Исправление выпускается новой миграцией.
- Откатываем только то, что применено, **в обратном порядке**. Каждый файл — одна
  транзакция с `lock_timeout 3s`.
- Воркеры при откате 0032–0034 должны стоять, как при применении.

Полный откат всего, что применено. Файл без строки в журнале пропускается: применение
могло остановиться раньше 0036, а откат 0036 без снимка `lockdown_backup.acl_20261015_0036`
падает сразу. Строки журнала откат не удаляет, поэтому проверка по журналу надёжна. Если
журнал не прочитался, цикл останавливается и ничего не пропускает молча:
```bash
for n in 0036_anon_definer_view_lockdown 0035_storage_private_buckets_gate 0034_rls_tables_staff_or_own_gate \
         0033_open_policies_staff_gate 0032_no_rls_tables_lockdown 0031_staff_gate_helpers 0030_profiles_read_lockdown; do
  r="$(printf "select count(*) from public.portal_migrations where name = '20261015_%s.sql';\n" "$n" | $LK_PSQL_RO -X -At -v ON_ERROR_STOP=1)" \
    || { echo "STOP: журнал не прочитан ($n)"; break; }
  case "$r" in
    1) ;;
    0) echo "-- $n: не применён, пропуск"; continue ;;
    *) echo "STOP: журнал ответил '$r' ($n)"; break ;;
  esac
  echo "== $n"
  $LK_PSQL -X -q -v ON_ERROR_STOP=1 < "supabase/operator-sql/20261015_$n.rollback.sql" || { echo "STOP: $n"; break; }
done
```
После `STOP` цикл можно запустить снова, когда причина устранена. Уже откаченные файлы
откатятся повторно, и это безопасно: rollback-файлы повторяемы. Остальные файлы дают
только NOTICE `does not exist, skipping`, а откат 0036 пишет
`0 relation/column/function ACLs restored`.
Точечный откат, когда сломалось одно место:

| Что сломалось | Что откатить | Ограничения |
|---|---|---|
| Файлы в `briefs` и `knowledge-base` | только `0035` | независим |
| RPC или вьюха «permission denied for function» | только `0036` | независим. Сначала посмотри, что он вернёт: запрос в шапке файла |
| Клиентские пути: парсеры, конструктор, поддержка, робот Bench | `0034` | независим |
| Таблицы из списка `0033` | `0036`, `0034`, потом `0033` | порядок из шапки 0033 |
| Таблицы без RLS (59 штук) | `0032` | независим |
| Чтение `profiles` | `0030`, это снова откроет чтение профилей всем вошедшим | Быстрый рычаг из шапки: если PostgREST пишет «permission denied for function is_internal_staff», нужен `grant execute on function public.is_internal_staff() to authenticated;` |
| `is_api_robot()` | `0031` только последним перед 0030, после отката 0036, 0034 и 0033 | |

На стенде (PostgreSQL 15.18, база P4) полный откат после применения вернул политики и
флаги RLS ровно к состоянию «до»:
- клиентская утечка вернулась, anon остался закрыт: хотфикс откат не трогает;
- без изменений остаются функция `is_internal_staff()`, схема `lockdown_backup`, а
  также EXECUTE для PUBLIC и anon на `search_pdl_companies` и `pdl_count_estimate`.
  Шапки rollback-файлов описывают это как намеренное.

Код ночью не выкатывается, его откатывать не нужно.

## 10. После окна

Записать в `docs/security/2026-10-15-anon-hotfix/README.md` или отдельной заметкой:
- коммит;
- время каждого файла (репетиция и применение);
- `exit` всех шагов;
- строку `SMOKE|fingerprint` после применения;
- результат внешних проверок.

Каталог `$LK_LOG_DIR` сохранить. Сообщить команде, что фоновые задачи снова идут.

Код серии (`d3c7d7dd5` — код, `7b5dd9fb5` — скрипты restore) выходит позже через
Sergey. До него работает текущий прод-код: это проверено смоуком и эмуляцией P4.
Исключение одно: поиск роботов Bench в `company-base` по названию упирается в
таймаут (раздел 0).

**Незакоммиченные правки — закоммитить до выпуска через Sergey.** На 15.10 часть
работы лежит только в рабочем дереве worktree `profiles-lockdown`, ни в одном коммите:
- `app/src/lib/bench/tools/companyBase.ts`: поиск Bench по названию идёт через
  `search_pdl_companies`. Без этой правки поиск остаётся медленным и после выпуска
  кода. Копия правки на случай потери: `night/fix-coverage/companyBase.ts.patch`
  в scratchpad сессии;
- `.semaphore/select-deploy-targets.sh`;
- правки 0030 и 0035, их rollback и preflight, этот runbook, скрипты
  `20261015_lockdown_{apply,rehearsal}.sh`, `20261015_lockdown_smoke.sql` и README хотфикса.
  Полный список покажет `git status` в worktree.

В коммите должны лежать **ровно те байты, что применены ночью**. Сверь sha256 семи
файлов с разделом 1.1. Если раннер деплоя увидит в журнале имена с другим содержимым,
он их не тронет, и репозиторий навсегда разойдётся с продом. Сообщения коммита
`98e6d4efb` устарели: в них старые числа самопроверок.

**Отложенное, не на эту ночь:**
- PostgREST на проде открывает и схему `storage` (`PGRST_DB_SCHEMAS`). 0036 снимает
  право вызова SECURITY DEFINER-функций только в `public`.
  `storage.delete_leaf_prefixes(text[],text[])` — SECURITY DEFINER от
  `supabase_admin`, и вызвать её может любой, включая anon. Сегодня это безвредно:
  таблицы `storage.prefixes` на проде нет, вызов падает. Даже рабочая, функция удаляет
  только пустые записи префиксов.
  После любого обновления образа storage-api проверь definer-функции в `storage`,
  доступные anon и authenticated. Другой путь — убрать `storage` из `PGRST_DB_SCHEMAS`,
  если через `/rest/v1` эту схему никто не читает.

## Приложение А. Расхождение конфигурации воркеров (для шага 1.7)

Скрипт только читает: `docker compose config`, `docker inspect`, `docker image inspect`.
Значения переменных он не печатает, только имена: переменные `.env` содержат ключи.
Сохрани его на Mac один раз, до шага 1.7:
```bash
cat > "$LK_LOG_DIR/worker-drift.py" <<'PY'
# Read-only: what `docker compose up` would change for each portal worker. Names only, never values.
import hashlib, json, os, subprocess, sys
from collections import defaultdict

def run(*a):
    return subprocess.run(a, capture_output=True, text=True, check=True).stdout

def env_map(lst):
    out = {}
    for e in lst or []:
        k, _, v = e.partition('=')
        out[k] = v
    return out

os.chdir('/home/Portal/prod')
dc = ['docker', 'compose', '--env-file', '.env', '-p', 'portal', '-f', 'docker-compose.prod.yml']
cfg = json.loads(run(*dc, 'config', '--format', 'json'))
want_hash = dict(l.split(' ', 1) for l in run(*dc, 'config', '--hash', '*').split('\n') if ' ' in l)
groups = defaultdict(list)
digest = lambda v: hashlib.sha256(('' if v is None else str(v)).encode()).hexdigest()
for svc, spec in sorted(cfg['services'].items()):
    if not svc.startswith('worker-'):
        continue
    ids = run('docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=portal',
              '--filter', 'label=com.docker.compose.service=' + svc).split()
    if len(ids) != 1:
        groups[('containers=%d' % len(ids),)].append(svc)
        continue
    c = json.loads(run('docker', 'inspect', ids[0]))[0]
    img = json.loads(run('docker', 'image', 'inspect', c['Image']))[0]
    have = env_map(c['Config']['Env'])
    want = env_map(img['Config'].get('Env'))
    want.update({k: ('' if v is None else str(v)) for k, v in (spec.get('environment') or {}).items()})
    same_hash = c['Config']['Labels'].get('com.docker.compose.config-hash') == want_hash.get(svc, '').strip()
    removed = tuple(sorted(set(have) - set(want)))
    added = tuple(sorted(set(want) - set(have)))
    changed = tuple(sorted(k for k in set(have) & set(want) if digest(have[k]) != digest(want[k])))
    groups[('config-hash ' + ('same' if same_hash else 'DIFFERS'),
            'only in the running container: ' + (' '.join(removed) or '-'),
            'only in compose/.env now: ' + (' '.join(added) or '-'),
            'value differs: ' + (' '.join(changed) or '-'))].append(svc)
for key, svcs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
    print('%d service(s): %s' % (len(svcs), ' '.join(svcs)))
    for line in key:
        print('    ' + line)
PY
```
Для каждого сервиса `worker-*` скрипт сравнивает:
- метку `com.docker.compose.config-hash` контейнера с `docker compose config --hash`;
- переменные контейнера с тем, что дадут сейчас образ, compose и `.env`.

Сервисы с одинаковым расхождением выводятся одной группой.

## Как это проверено (15.10, до окна)

- **Стенд.** Реальный PostgreSQL 15.18, а не PGlite:
  - база P4: все миграции репозитория, эмуляция прод-ACL и синхронизация каталога прода
    `map/coverage-1015`;
  - доступ через подставной `psql`, который режет ввод как `psqlscan`;
  - подставной `docker`, который пропускает только `ps` и `exec psql`.

  70 проверок, все прошли:
  - отказы готовности: воркеры, `docker ps`, транзакция старше 3 с, сильная блокировка,
    режим `--check` и план на read-only сессии, нет отметки репетиции, файл
    `no-transaction` в репетиции;
  - настоящий дедлок репетиции с живым запросом. Запрос держит `projects` и идёт в
    `profiles`. Репетиция получает 40P01, сама повторяет прогон и проходит, а запрос
    завершается нормально. Два дедлока подряд дают `exit=3` с подсказкой. С
    `LK_REHEARSAL_DEADLOCK_RETRIES=0` повтора нет;
  - обрыв ssh на 0032 (код 255), после которого сессия на сервере коммитит файл уже
    после проверки журнала. Повтор упирается в 23505 `portal_migrations_pkey`, скрипт
    засчитывает файл и доводит серию. Строка 0032 в журнале одна, итог равен чистому
    прогону;
  - цикл полного отката из раздела 9, взятый из этого файла как есть. После остановки
    в 0034 он пропускает 0036, 0035 и 0034, откатывает 0033…0030 и возвращает политики
    и RLS к состоянию «до». Повторный запуск безвреден. После полного применения он
    откатывает все семь;
  - репетиция откатывает всё;
  - применение, смоук и отпечаток равны отпечатку репетиции;
  - повторный запуск ничего не делает;
  - итог совпадает с настоящим `ensureDatabase.js` на той же базе;
  - сбой внутри 0033: 0030–0032 закоммичены, 0033–0036 нет, после исправления
    повторный запуск доводит серию до того же итога;
  - повторы на 55P03, на убитом соединении и на 57014 в фазе `lock table`; без повтора
    на 57014 вне её;
  - файлы `no-transaction`;
  - смоук до серии падает, как и должен, смоук Instantly DB ловит изменение таблицы;
  - полный откат в обратном порядке.
- **Прод, только чтение:**
  - `rehearsal.sh --check` и план `apply.sh` с Mac по ssh отказали из-за 55 воркеров и
    одной PostgREST-транзакции VE;
  - больше ничего не мешает, все прочие миграции репозитория в журнале;
  - смоук на main DB настоящим `psql 15.8`: все проверки отработали, ожидаемые FAIL до
    применения;
  - смоук на Instantly DB: PASS;
  - в 16:10 UTC: у 46 воркеров `config-hash` расходится с compose. Причина одна:
    `TA_SCORING_JEV_SURFACES` есть в контейнере и убран из `.env`. У 9 enrich-воркеров
    расхождения нет. Команды шагов 1.7, 2.2 и 6 (кроме самого `docker start`)
    прогнаны на проде;
  - `portal-backup`: 14.10 main-дамп был готов в 19:09 UTC, выгрузка в S3 закончилась в
    19:58 UTC;
  - `main-rest`: `PGRST_DB_POOL=30`, `PGRST_DB_POOL_ACQUISITION_TIMEOUT=10`. Ноды
    сендера получили 18 ответов 504 за одну минуту в 14:00 UTC;
  - на хосте нет крона, который запускает воркеры. Кроны делают `docker exec` в уже
    запущенные контейнеры или `docker run --rm` своих разовых контейнеров.
