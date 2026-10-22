# main-db-prod — Supabase-стек main БД на прод-сервере

> Статус на 22.07.2026: боевое переключение завершено; DB-хост переехал на
> `139.60.162.12`. **Обновление 2026-09-10: прод-сервер доступен по адресу
> `139.60.162.24` (тот же host key), весь стек включая `main-postgres` (:35434),
> Kong (:35480) и instantly-postgres (:35432) работает там.** Хост
> `144.31.54.166` временно сохраняется только для rollback
> и вспомогательных сервисов. Ниже оставлена история и процедура переезда.

Кит для переноса main-supabase со 144.31.54.166 (DB-сервер) на прод (исторически 139.60.162.12, сейчас 139.60.162.24).
Контекст и анализ: memory `db-migration-to-prod` (сессия 18.07.2026).

Файлы `docker-compose.yml`, `restore.sh`, `verify.sh` — источник здесь, в репо.
Секреты (`.env`), `kong.yml` и `main-init/` в репо НЕ живут — они добавляются
из боевых копий на 144 (`/opt/main-db/.env`, `/opt/main-db/kong.yml`,
`/opt/instantly-db/main-init/`). Собранный кит: `144:/root/main-db-prod-kit/`.

## Фаза 1 — репетиция (без простоя)

На проде: забрать кит со 144 в `/opt/main-db`, поднять только `main-postgres`,
восстановить последний дамп из volume `portal-backup` (`restore.sh` — печатает
длительность, это оценка окна Фазы 2), поднять остальной стек, `verify.sh`.
Эталон данных: auth.users=70, storage.objects=3020 (на 18.07.2026).

⚠️ Во время репетиции НЕ загружать/удалять файлы через тестовый стек — S3-бакет
общий с боевым. Только чтение/проверки.

Снести репетицию: `docker compose -p main-supabase --env-file .env down -v`.

## Итог репетиции 18.07.2026

Успех: стек на проде, данные чистые, все API 200. Чистый restore 25 GB ≈ **50 мин** (-j 4).
Все пойманные грабли вшиты в скрипты: partial-дампы, версия pg_restore (17 vs 15),
защита от restore-в-непустую-базу, служебные роли/пароли/членства/search_path/_realtime
(см. комментарии в fix-roles.sql и restore.sh). Тестовый стек оставлен работать.

## Подготовка к боевой ночи (заранее, не в окно)

- Замерить скорость scp 144→139 (перекинуть любой дамп ~3.7 GB, засечь время) —
  WAN между ДЦ медленный, это слагаемое окна.
- Проверить, что kit на 144 актуален (`/root/main-db-prod-kit/`).
- Предупредить команду о ночном простое (~2 часа).

## Фаза 2 — боевая ночь (окно ≈ 50 мин restore + передача дампа + ~30 мин на всё остальное)

1. **Заморозка записи**: на проде `docker compose stop` прод-стека приложения
   (portal + все воркеры). polza-site-* не трогать — у него своя БД.
2. **Свежий дамп локально на 144** (минуты, не часы — без WAN):
   `docker exec main-postgres pg_dump -U supabase_admin -d postgres --format=custom
   --compress=6 --no-owner --no-privileges <те же --exclude-schema, что в
   services/backup/backup.sh> -f /tmp/fresh.dump`, затем `docker cp` наружу.
3. **Передать дамп на прод** (scp 144→139, время известно из замера).
4. **На проде**: `down -v` тестовой базы → `up -d main-postgres` → `restore.sh <дамп>`
   → `bash finish.sh` (роли/права/закрытие anon/стек/проверка — всё внутри; с 15.10.2026
   рядом нужен `reapply-privileges.sql`, см. «Права после restore» ниже).
5. **pg_cron джоба** (schema cron не входит в дамп; единственная джоба на 18.07.2026):
   `SELECT cron.schedule('cleanup-old-project-notes', '5 3 * * *', 'SELECT public.cleanup_old_project_notes()');`
6. **Переключение конфигов**:
   - в ките `.env`: `MAIN_API_EXTERNAL_URL` / `MAIN_SITE_URL` со 144 на прод-IP, затем
     `docker compose -p main-supabase --env-file .env up -d` (пересоздаст auth/kong);
   - в прод `.env` приложения: `NEXT_PUBLIC_SUPABASE_URL` → `http://139.60.162.12:35480`,
     `DATABASE_URL`/`MAIN_SUPABASE_DATABASE_URL` → хост `139.60.162.12:35434`
     (публичный IP, не localhost — NEXT_PUBLIC_-URL ходит и в браузеры пользователей).
7. **Поднять приложение** (`docker compose start`/`up -d`), смоук: логин, открытие
   файла/аватара, чат поддержки (realtime!), запуск парсера, создание записи.
8. **Наблюдение** 1–2 дня. База на 144 остаётся нетронутой 1–2 недели — это откат.

Откат: вернуть старые URL в прод `.env` приложения, перезапустить приложение.
База на 144 всё это время живёт и не менялась (воркеры были остановлены).

## После переезда

- Бэкап main станет локальным (pg_dump на том же хосте) — WAN-инцидент уходит.
- Kong на 144 можно оставить работать до конца страховочного периода, потом гасить.
- studio/meta/imgproxy сюда не переносятся: админка — на 144 или по требованию,
  image transformation приложением не используется (проверено 18.07.2026).

## Права после restore (с 15.10.2026)

**Деплой эти скрипты не запускает.** Деплой приложения применяет только
`supabase/migrations` (`app/scripts/db/ensureDatabase.js`, шаг 1.1) и только файлы,
которых нет в `portal_migrations`. `restore.sh`, `fix-roles.sql`,
`reapply-privileges.sql`, `finish.sh` и `main-init/` срабатывают, только когда их
запускает оператор: restore в свежий volume или initdb нового кластера. План деплоя
изменения в `deploy/main-db-prod/*` не выбирает (`.semaphore/select-deploy-targets.sh`),
на работающий прод они не влияют.

**Почему поменялись.** Дамп `--no-owner --no-privileges` теряет все GRANT/REVOKE и
права по умолчанию, а строки `portal_migrations` в нём есть, поэтому деплой миграции
второй раз не применит. Старый `fix-roles.sql` выдавал `ALL` на все таблицы, сиквенсы и
функции `public` ролям `anon` (публичный ключ из браузерного бандла) и `authenticated`.
`main-init` даёт `anon` SELECT по умолчанию на всё, что создаёт `supabase_admin`, то есть
на всю восстановленную базу. Так после июльского restore anon и открылся (хотфикс
15.10.2026 в `docs/security/2026-10-15-anon-hotfix/`, миграции `20261015_0030..0036`).

**Что делает finish.sh.**
1. Проверяет, что рядом лежат `.env`, `fix-roles.sql`, `reapply-privileges.sql` и
   `verify.sh` и что restore закончился. Иначе останавливается, ничего не трогая.
2. `fix-roles.sql`, как раньше, с `ON_ERROR_STOP=0`: роли, пароли, владельцы схем auth
   и storage. В `public` anon получает только USAGE на схему. `ALL ON ALL TABLES` и
   `ALL ON ALL SEQUENCES` получают postgres, authenticated и service_role,
   `ALL ON ALL FUNCTIONS` только postgres и service_role. С anon снимаются права на
   таблицы и сиквенсы и права по умолчанию у `supabase_admin`.
3. `reapply-privileges.sql` одной транзакцией (`psql -X -v ON_ERROR_STOP=1 -1`). В нём
   только GRANT, REVOKE и ALTER DEFAULT PRIVILEGES, объекты находятся по каталогу:
   - anon и PUBLIC не получают ничего, кроме трёх осознанных объектов;
   - SECURITY DEFINER-функции закрыты для PUBLIC и anon; authenticated исполняет только
     функции из списка `c_auth_definers` и те, что вызывают политики;
   - вьюхи и service-only таблицы 0032 закрыты для authenticated;
   - права по умолчанию ничего не дают anon, новые функции роли postgres не получают
     PUBLIC.

   Подробности в шапке файла. В конце файл сам проверяет результат. Если проверка не
   сошлась, откатывается всё, finish.sh пишет FATAL и **стек не запускает**.
4. Если в `portal_migrations` нет строки `20261015_0036_…`, пишет WARNING (дамп старше
   lockdown, см. ниже) и продолжает.
5. Печатает права anon в `public` (ждём ровно три строки), поднимает стек и запускает
   `verify.sh`. В конце шлёт два запроса anon-ключом через Kong: `/rest/v1/profiles` и
   `/rest/v1/rpc/is_internal_staff`. Оба должны ответить **401** с кодом 42501 (строка
   «— 42501, закрыто»). Ответ 200 значит, что anon снова открыт: останови Kong
   (`docker stop main-kong`) и разбирайся.

**Почему не повтор миграций.** Первая версия finish.sh повторяла файлы 0030, 0031, 0032
и 0036. Они написаны под схему 15.10.2026. После поздней миграции повтор либо падал, и
стек после restore не стартовал (например, удалили `ve_search_cache`, у
`can_view_team_activity_plan` сменилась сигнатура, переименовали
`profiles.is_api_robot`). Либо повтор молча откатывал позднюю правку: `CREATE OR REPLACE`
для `is_internal_staff()` и `is_api_robot()`, `DROP/CREATE` политик.
`reapply-privileges.sql` не создаёт и не меняет ни функций, ни политик. Отсутствующий
объект он пропускает, дрейф схемы отмечает WARNING.

**Дамп старше 15.10.2026** (бандл или дамп, снятый до деплоя 0030–0036). После finish.sh
anon закрыт, но политики и RLS такие, как в дампе. Любой вошедший видит чужие профили и
таблицы без RLS; `reapply-privileges.sql` перечисляет такие таблицы в WARNING. Сразу
после старта примени недостающие миграции тем же раннером, что деплой. На проде, из
`/home/Portal/prod`:

```sh
sudo docker run --rm --network host --env-file .env <DOCKER_USERNAME>/portal:prod node scripts/db/ensureDatabase.js
```

Раннер применит только файлы, которых нет в `portal_migrations`. Для 0032–0034 нужно то
же окно, что в разделе «Релиз …» ниже. На стенде (PGlite) после `reapply-privileges.sql`
применяются все семь файлов, и права совпадают с задеплоенными.

**Кит перед restore.** В `/opt/main-db` положи из репозитория `fix-roles.sql`,
`reapply-privileges.sql` и `finish.sh` из коммита, который стоит на проде. `main-init/`
берётся со 144 и по-прежнему даёт anon SELECT по умолчанию. `fix-roles.sql` и
`reapply-privileges.sql` это снимают; на стенде проверено и со старым main-init, и с
правами по умолчанию образа supabase/postgres. Правку самого
`deploy/instantly-db/main-init/01-init-portal.sql` выпускаем отдельным PR, не вместе с
lockdown. Любое изменение `deploy/instantly-db/main-init/*` включает в релиз стек
Instantly DB (`idb=1`: `pull`, `up -d --build`, мигратор Instantly). На плавающем теге
`postgres:16-alpine` это может перезапустить Instantly Postgres.

**Подсказки в `restore.sh` и в шапке `docker-compose.yml`** («`up -d` и `verify.sh`»)
пропускают finish.sh. После restore всегда запускай `bash finish.sh`: стек без
`reapply-privileges.sql` снова открыт для anon.

**Что restore по-прежнему не возвращает** (так было и до 15.10.2026, anon не касается):
- authenticated получает ALL на все таблицы и сиквенсы `public`, в том числе там, где
  миграции оставили ему меньше. Доступ решают RLS (после 0032 он включён на всех
  таблицах `public`) и шлюзы 0032–0034. На стенде ни клиенты, ни сотрудники новых строк
  или записей от этого не получили. Но таблица без RLS, созданная позже, так
  открывается любому вошедшему. `reapply-privileges.sql` перечисляет такие таблицы в
  WARNING: включи на них RLS или сними grant.
- Обычные (не SECURITY DEFINER) функции, у которых миграции забрали EXECUTE,
  возвращаются к умолчанию PostgreSQL (EXECUTE для PUBLIC). Они работают с правами
  вызывающего. service_role получает EXECUTE на все функции.
- Прямые логины (readonly для MCP, nick_ro) теряют права на таблицы и существующие
  функции. Выдай их заново руками. Права по умолчанию на новые функции им возвращает
  `reapply-privileges.sql`, как и 0036.
- SECURITY DEFINER-функция, которую поздняя миграция открыла authenticated, но которую не
  внесли в `c_auth_definers`, после restore закрыта и для authenticated, и для anon. Это
  осознанно: лучше сломанная кнопка у сотрудника, чем открытая всем функция
  суперпользователя.
- Restore из бандла (`services/backup/restore-bundle.sh`, режим `main-bundle`) сохраняет
  владельцев, права и роли, эти скрипты ему не нужны. Бандл, снятый до деплоя 0030–0036,
  вернёт и тогдашние открытые права. Их закроет следующий деплой, потому что строк этих
  миграций в таком бандле нет. До него можно прогнать `reapply-privileges.sql` руками
  (`psql -X -v ON_ERROR_STOP=1 -1 -f`): он закрывает anon и на такой базе.

**Правило на будущее.**
- Миграция, которая меняет только GRANT/REVOKE или права по умолчанию, после такого
  restore теряется молча. Отрази её в `reapply-privileges.sql` правилом или в списке.
- Новую SECURITY DEFINER-функцию, которую браузер вызывает с JWT пользователя, внеси в
  `c_auth_definers`. Списки `c_anon_select`, `c_anon_insert`, `c_views_for_jwt`,
  `c_auth_definers` и `c_direct_fn_roles` повторяют `lk_cfg` в `20261015_0036`, а
  `c_service_only` повторяет режим `service` в `20261015_0032`.
- Надёжнее, чтобы права вообще не терялись: снимать main-дамп без `--no-privileges` или
  сделать restore из бандла основным путём. Это отдельное решение по `services/backup`.

## Релиз миграций 20261015_0030…0036 на прод

Окно выбирает владелец. До окна ветка с этими файлами не должна попасть в `main`: любой
мерж Sergey→main отправит их ближайшим плановым деплоем.

**Почему по шагам.** Миграции применяет шаг 1.1 деплоя (`.semaphore/scheduled-deploy.yml`:
`docker run … node scripts/db/ensureDatabase.js` из нового образа). В этот момент старый
portal и **все** воркеры ещё работают; дренаж (шаг 2) идёт после миграций. 0032–0034
берут ACCESS EXCLUSIVE на десятки таблиц. Каждое ожидание блокировки ограничено 3 с, вся
фаза блокировок 30 с. В 0033 прямо сказано, что каталожные RPC по `companies_directory`
и `pdl_companies` идут до 180 с и фаза блокировок с ними не уложится. Раннер повторяет
55P03/57014 до 6 раз через 5 с, то есть около минуты. Длинная транзакция воркера,
`pg_dump` или анти-wraparound автовакуум на `pdl_companies` (его не отменяет никто)
переживут все попытки. Тогда деплой падает с «DEPLOY ABORTED: migration precheck failed».
К этому моменту 0030–0032 уже применены, остальные висят, и каждый следующий деплой,
хотфиксы тоже, упирается в ту же стену. Каждая неудачная попытка на время ожидания
стопорит запросы к уже захваченным таблицам, а попытка 0030 стопорит чтение `profiles`
(middleware).

**Порядок.**
1. Окно не ближе получаса к 06:00 и 18:00 UTC (`pg_dump` бэкапа держит ACCESS SHARE на
   всех таблицах) и к 22:00 UTC (крон portal-mirror).
2. Проверки только на чтение, с согласия владельца:
   `supabase/operator-sql/20261015_lockdown_preflight.sql` и
   `supabase/operator-sql/20261015_0030_profiles_read_lockdown.preflight.sql`. В каждом
   блоке написано, что ждать.
3. Остановить **все** воркеры, а не только те, что выберет деплой. На проде, в
   `/home/Portal/prod`:
   ```sh
   sudo bash drain-worker.sh   # без аргументов: очереди на паузу, известные воркеры — мягко
   sudo docker compose --env-file .env -p portal -f docker-compose.prod.yml stop \
     $(sudo docker compose --env-file .env -p portal -f docker-compose.prod.yml config --services | grep '^worker-')
   ```
4. Сразу перед запуском обе выборки должны вернуть 0 строк:
   ```sql
   -- транзакции дольше 3 с
   select pid, usename, application_name, state, now() - xact_start as xact_age, left(query, 80)
   from pg_stat_activity
   where xact_start < now() - interval '3 seconds' and pid <> pg_backend_pid()
   order by xact_start;
   -- вакуум (анти-wraparound не уступает блокировке)
   select p.pid, p.relid::regclass, p.phase, a.query
   from pg_stat_progress_vacuum p join pg_stat_activity a using (pid);
   ```
5. Запустить деплой или шаг 1.1 руками (команда выше, в «Дамп старше 15.10.2026»).
   Следить за логом раннера.
6. После деплоя поднять всё, что остановлено на шаге 3. Деплой перезапускает только
   выбранные воркеры.
   ```sh
   sudo env DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)" docker compose --env-file .env -p portal \
     -f docker-compose.prod.yml up -d --no-deps \
     $(sudo docker compose --env-file .env -p portal -f docker-compose.prod.yml config --services | grep '^worker-')
   ```
7. Проверка: `docs/security/2026-10-15-anon-hotfix/verify.sql` (в V5 семь строк) и
   запрос anon-ключом из README хотфикса (ждём 401).
8. Если шаг 1.1 упал на 55P03 или 57014: найти держателя (`pg_stat_activity`,
   `pg_locks`), дождаться его или снять и повторить шаг 1.1 руками до следующего
   планового деплоя. Не оставлять висеть: следующий деплой упрётся в то же.

**План деплоя.** Файлы `supabase/operator-sql/*` в `.semaphore/select-deploy-targets.sh`
не размечены и попадают в ветку «неизвестный путь». Релиз с ними становится полным
(`full=1`): все core-сервисы, все воркеры, стек Instantly DB с `pull` и `up -d --build`,
бэкап, sender. Есть два выхода. Можно до релиза разметить `supabase/operator-sql/*` как
путь без действий (правка в `.semaphore/`). Иначе закладывай полный деплой в окно,
включая возможный перезапуск Instantly Postgres на плавающем теге `postgres:16-alpine`.
Пути `deploy/main-db-prod/*` и `docs/*` план не выбирает.

## Realtime (уведомления о задачах, с 23.10.2026)

Realtime определяет тенанта по первому слову имени хоста, на которое пришёл
запрос. Засеянный (`SEED_SELF_HOST`) тенант — `realtime-dev`, поэтому:

- у сервиса `realtime` в compose есть сетевое имя `realtime-dev`;
- в `/opt/main-db/kong.yml` маршруты `realtime-v1-ws` и `realtime-v1-rest` ведут на
  `http://realtime-dev:4000/...` (шаблон — `deploy/main-db/kong.yml`).

С июльского переезда до 23.10.2026 Kong ходил на `realtime:4000`, сервис отвечал
`TenantNotFound: Tenant not found: realtime`, и все воркеры жили на запасном
опросе раз в 30 с. Второе условие — публикация `supabase_realtime`: она не
пережила переезд и создаётся миграцией
`supabase/migrations/20261023_0001_realtime_publication.sql` (очереди воркеров и
чат поддержки; самые частые очереди оставлены на опросе — см. миграцию).

Проверка: в `docker logs main-realtime` нет `TenantNotFound`, в логах воркеров
`Realtime subscribed to: …`, в `pg_replication_slots` есть слот
`supabase_realtime_replication_slot…`.
