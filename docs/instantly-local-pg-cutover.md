# Cutover: Instantly Supabase → выделенный сервер PostgreSQL

## Архитектура

Instantly DB живёт на **отдельном сервере** от Portal, в `deploy/instantly-db/docker-compose.yml`.
Два инстанса (prod + dev) с отдельными pgAdmin; автобэкапы включены только для production. На хосте используются **нестандартные порты** (не 5432/3001), чтобы не пересекаться с другими сервисами на том же сервере. Внутри Docker-сети Postgres по-прежнему на `5432`, PostgREST на `3000`.

| Порт на хосте | Сервис | Кто подключается |
|---------------|--------|------------------|
| 35432 | PG prod | Portal-сервер (portal, instantly-sync-bot) |
| 35433 | PG dev | Разработчики (2 человека) |
| 35401 | PostgREST prod | Portal-сервер (Next.js через supabaseInstantly.ts) |
| 35402 | PostgREST dev | Разработчики |
| 127.0.0.1:35410 | pgAdmin prod | SSH tunnel |
| 127.0.0.1:35411 | pgAdmin dev | SSH tunnel |

## Деплой DB-сервера

### 1. Подготовка

```bash
# На DB-сервере
mkdir -p /home/instantly-db
cd /home/instantly-db

# Скопировать файлы из репозитория
# deploy/instantly-db/docker-compose.yml
# deploy/instantly-db/.env.example
# deploy/instantly-db/backup.sh
# deploy/instantly-db/Dockerfile.backup
# deploy/instantly-db/crontab
# deploy/instantly-db/scripts/db/ensureDatabase.js

# Скопировать миграции
mkdir -p migrations
cp supabase/instantly-migrations/*.sql migrations/

# Создать .env
cp .env.example .env
# Заполнить пароли в .env
```

### 2. Генерация паролей

```bash
# На сервере (или через node)
node -e "const c=require('crypto');
console.log('INSTANTLY_PROD_PG_PASSWORD=' + c.randomBytes(24).toString('base64'));
console.log('INSTANTLY_PROD_JWT_SECRET=' + c.randomBytes(32).toString('base64'));
console.log('INSTANTLY_PROD_PGADMIN_PASSWORD=' + c.randomBytes(24).toString('base64'));
console.log('INSTANTLY_DEV_PG_PASSWORD=' + c.randomBytes(24).toString('base64'));
console.log('INSTANTLY_DEV_JWT_SECRET=' + c.randomBytes(32).toString('base64'));
console.log('INSTANTLY_DEV_PGADMIN_PASSWORD=' + c.randomBytes(24).toString('base64'));"
```

### 3. Запуск

```bash
docker compose up -d
```

Migrator автоматически применит миграции к обоим инстансам.
Backup-контейнер по отдельному profile запускается Semaphore-деплоем и создаёт только два production bundle. Dev-базы не бэкапятся.

### 4. Проверка

```bash
# Postgres prod healthy?
docker inspect instantly-postgres-prod --format '{{.State.Health.Status}}'

# Postgres dev healthy?
docker inspect instantly-postgres-dev --format '{{.State.Health.Status}}'

# PostgREST prod отвечает?
curl -s http://localhost:35401/

# PostgREST dev отвечает?
curl -s http://localhost:35402/

# Migrator отработал?
docker logs instantly-migrator

# Backup-контейнер работает?
docker logs portal-backup
```

## Env-переменные на Portal-сервере

После деплоя DB-сервера, обновить `.env` на **Portal-сервере** (`/home/Portal/prod/.env`):

```env
# Заменить <DB_SERVER_IP> на IP DB-сервера (порты — внешние из compose)
INSTANTLY_DATABASE_URL=postgresql://instantly:<PROD_PG_PASSWORD>@<DB_SERVER_IP>:35432/instantly
INSTANTLY_SUPABASE_URL=http://<DB_SERVER_IP>:35401
INSTANTLY_SUPABASE_SERVICE_ROLE_KEY=local-no-supabase
```

Для **локальной разработки** (`.env` на машинах разработчиков):

```env
INSTANTLY_DATABASE_URL=postgresql://instantly:<DEV_PG_PASSWORD>@<DB_SERVER_IP>:35433/instantly
INSTANTLY_SUPABASE_URL=http://<DB_SERVER_IP>:35402
INSTANTLY_SUPABASE_SERVICE_ROLE_KEY=local-no-supabase
```

## Подключение к pgAdmin

pgAdmin доступен только через SSH tunnel:

```bash
# Prod pgAdmin (удалённый 35410 → локальный 5050)
ssh -L 5050:127.0.0.1:35410 <user>@<DB_SERVER_IP>
# Открыть http://localhost:5050

# Dev pgAdmin (удалённый 35411 → локальный 5051)
ssh -L 5051:127.0.0.1:35411 <user>@<DB_SERVER_IP>
# Открыть http://localhost:5051
```

В UI pgAdmin создать сервер:
- Host: `instantly-postgres-prod` (или `instantly-postgres-dev`)
- Port: `5432`
- Database: `instantly`
- Username: `instantly`
- Password: из `.env`

## Перенос данных из Supabase

### 1. Initial full load (до окна обслуживания)

```bash
INSTANTLY_SOURCE_DB_URL="postgresql://postgres.pwcidzaqudfkodgmesyk:<pass>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres" \
INSTANTLY_DATABASE_URL="postgresql://instantly:<PROD_PG_PASSWORD>@<DB_SERVER_IP>:35432/instantly" \
  node app/scripts/migrate-instantly-to-local-pg.mjs

# Verify
INSTANTLY_SOURCE_DB_URL="..." INSTANTLY_DATABASE_URL="..." \
  node app/scripts/migrate-instantly-to-local-pg.mjs --verify
```

### 2. Окно обслуживания (~5 мин)

```bash
# Остановить писателей
docker compose -p portal stop worker-instantly-leads instantly-sync-bot

# Delta sync
INSTANTLY_SOURCE_DB_URL="..." INSTANTLY_DATABASE_URL="..." \
  node app/scripts/migrate-instantly-to-local-pg.mjs --delta

# Final verify
INSTANTLY_SOURCE_DB_URL="..." INSTANTLY_DATABASE_URL="..." \
  node app/scripts/migrate-instantly-to-local-pg.mjs --verify

# Обновить .env (см. выше) и перезапустить
docker compose -p portal -f docker-compose.prod.yml up -d --no-deps --force-recreate \
  portal worker-instantly-leads instantly-sync-bot
```

### 3. Smoke-checks

| Проверка | Команда / URL |
|---|---|
| Каталог кампаний | `GET /api/instantly/campaigns` |
| Квалификации лидов | `GET /api/instantly/qualified-leads` |
| Webhook запись | `POST /api/instantly/events` с тестовым payload |
| Sync-бот | `docker logs portal-instantly-sync-bot --tail 50` |
| agent_query_readonly | Telegram-бот → SQL-запрос к Instantly DB |
| Бриф | `GET /api/instantly/briefs` |
| Клиентские лиды | `GET /api/client/leads` |

### 4. Rollback

```bash
# Вернуть старые значения в .env:
#   INSTANTLY_SUPABASE_URL=https://pwcidzaqudfkodgmesyk.supabase.co
#   INSTANTLY_SUPABASE_SERVICE_ROLE_KEY=<old service role key>
#   INSTANTLY_DATABASE_URL=<old Supabase transaction pooler URL>

docker compose -p portal -f docker-compose.prod.yml up -d --no-deps --force-recreate \
  portal worker-instantly-leads instantly-sync-bot
```

### 5. Отключение Supabase (через 24-48 часов)

- Отключить или заморозить проект `pwcidzaqudfkodgmesyk`.
- Удалить `INSTANTLY_SOURCE_DB_URL` из .env.

## Обновление миграций

При добавлении новых SQL-файлов в `supabase/instantly-migrations/`:

1. Скопировать новый файл в `migrations/` на DB-сервере
2. `docker compose up instantly-migrator` (или `docker compose restart instantly-migrator`)

Либо автоматизировать через CI: scp + docker compose up.

## Автобэкапы

Сервис `portal-backup` запускается на **DB-сервере** из
`deploy/instantly-db/docker-compose.yml` и использует локальную Docker-сеть.
Автоматически создаются только production-бэкапы; dev-базы намеренно исключены.
Каждый запуск формирует один tar-bundle и сразу загружает его в S3.

| Источник | Расписание (UTC) | Путь в S3 | Локальный ретеншн | S3-ретеншн |
|----------|------------------|------------|-------------------|-------------|
| Main production bundle | `06:00` и `18:00` | `portal-main/full/` | 7 дней | 7 дней |
| Instantly production bundle | `06:15` и `18:15` | `instantly/full/` | 7 дней | 7 дней |

Main bundle содержит полный custom-format дамп БД `postgres`, роли, membership,
права и хэши паролей ролей. Instantly bundle содержит две production-базы —
`instantly` и `instantly_dataset` — плюс роли и права кластера. Ownership и ACL
в full-bundle сохраняются. В каждый архив также вложен `restore-bundle.sh`.

Восстанавливать main bundle нужно в свежий `main-postgres` из того же Supabase
compose: необходимые бинарники расширений предоставляет образ Supabase Postgres.
Файлы Supabase Storage в DB-bundle не дублируются — они уже находятся в S3;
в дампе сохраняются их метаданные из PostgreSQL.

### Параметры в `/opt/instantly-db/.env`

URL подключения вручную переносить не нужно: compose собирает их из уже
существующих `MAIN_PG_PASSWORD`, `INSTANTLY_PROD_PG_PASSWORD` и
`INSTANTLY_DEV_PG_PASSWORD`, а хостами служат локальные контейнеры.

С Portal-сервера нужно перенести только параметры S3 и Telegram:

- `BACKUP_S3_ENDPOINT`
- `BACKUP_S3_BUCKET`
- `BACKUP_S3_ACCESS_KEY_ID`
- `BACKUP_S3_SECRET_ACCESS_KEY`
- `BACKUP_S3_REGION`
- `TELEGRAM_HEALTH_BOT_TOKEN` / `TELEGRAM_HEALTH_CHAT_ID`

Ротация задаётся через `BACKUP_RETENTION_DAYS` и
`BACKUP_REMOTE_RETENTION_DAYS`. Полный шаблон находится в
`deploy/instantly-db/.env.example`.

### Алерты и чистка

Алерт уходит в Telegram при двух событиях:
1. `pg_dump` упал (ненулевой exit code)
2. загрузка в S3 не удалась после всех повторов

После успешной загрузки скрипт удаляет из S3 дампы старше заданного срока.
Если загрузка упала, удалённая чистка пропускается, чтобы не остаться без копии.

### Первый запуск / обновление

Сервис вынесен в профиль `backup`, поэтому обычный `docker compose up` его не
пересоздаёт и не может оборвать работающий `pg_dump`. При отдельном обновлении
контейнеру даётся до четырёх часов на завершение активного дампа и загрузки в S3:

Semaphore выполняет этот отдельный `pull`/`up` автоматически при каждом деплое,
если настроен `INSTANTLY_DB_SSH_HOST`. Перед первым деплоем достаточно один раз
добавить обязательные `BACKUP_S3_*` в `/opt/instantly-db/.env`; сам `.env` через
CI намеренно не копируется. Команды ниже нужны только для внепланового ручного
обновления:

```bash
cd /opt/instantly-db
docker compose -p instantly-db --env-file .env --profile backup pull portal-backup
docker compose -p instantly-db --env-file .env --profile backup \
  up -d --no-deps portal-backup
```

При первом Semaphore-деплое старый контейнер на Portal-сервере выводится из
работы автоматически. Если в нём уже идёт backup job, CI отключает старый cron,
даёт текущей задаче завершиться и затем останавливает контейнер. Named volume со
старыми локальными дампами специально не удаляется. Ручной эквивалент:

```bash
# Выполнять на Portal-сервере только когда старый backup job не запущен.
if docker top portal-backup -eo args 2>/dev/null | grep -Fq '/backup.sh '; then
  echo 'Старый backup job ещё работает — контейнер пока не удаляем'
else
  docker rm -f portal-backup
fi
```

### Ручной запуск

```bash
# С DB-сервера
docker exec portal-backup /backup.sh main-full
docker exec portal-backup /backup.sh instantly-full
```

### Восстановление production bundle

```bash
# Main: скачать один tar из S3 через настроенный backup-контейнер
docker exec portal-backup sh -c '. /etc/backup.env; \
  mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY_ID" \
    "$BACKUP_S3_SECRET_ACCESS_KEY" --api s3v4 >/dev/null; \
  mc cp "backup/$BACKUP_S3_BUCKET/portal-main/full/portal-main-main-full-YYYYMMDD_HHMMSS.tar" \
    /backups/main-full.tar'
docker cp portal-backup:/backups/main-full.tar ./main-full.tar
mkdir main-restore && tar -xf main-full.tar -C main-restore
cd main-restore
./restore-bundle.sh main main-postgres

# Instantly: архив содержит instantly + instantly_dataset + роли
docker exec portal-backup sh -c '. /etc/backup.env; \
  mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY_ID" \
    "$BACKUP_S3_SECRET_ACCESS_KEY" --api s3v4 >/dev/null; \
  mc cp "backup/$BACKUP_S3_BUCKET/instantly/full/instantly-instantly-full-YYYYMMDD_HHMMSS.tar" \
    /backups/instantly-full.tar'
docker cp portal-backup:/backups/instantly-full.tar ./instantly-full.tar
mkdir instantly-restore && tar -xf instantly-full.tar -C instantly-restore
cd instantly-restore
./restore-bundle.sh instantly instantly-postgres-prod
```

Перед restore должен работать только свежий целевой PostgreSQL-контейнер;
приложение и остальные Supabase/Instantly-сервисы запускаются после успешного
завершения скрипта. Restore использует `postgres:17-alpine` как клиент и четыре
параллельных job; переопределение: `RESTORE_JOBS=8`. Бандл восстанавливает хэши
паролей ролей с исходного production-кластера, поэтому секреты подключения в
`.env` целевого стека должны совпадать с исходными. После проверки на пустоту
скрипт пересоздаёт только целевые production-базы через `pg_restore --create` —
так восстанавливаются также owner, ACL и database-specific settings.

### Тесты

Контракт `backup.sh` покрыт shell-тестами в `services/backup/test_backup.sh`
(нужен только bash; `pg_dump` и `curl` шиммируются через PATH; никаких внешних
зависимостей):

```bash
bash services/backup/test_backup.sh
# TESTS:   passed=110  failed=0
```

### Снос старого instantly-backup на DB-сервере

При первом запуске scheduled-deploy после этого изменения старый контейнер
`instantly-backup` на DB-сервере будет автоматически удалён
(`docker rm -f instantly-backup`). Если нужно убрать вручную сразу:

```bash
ssh root@<DB_HOST>
sudo docker rm -f instantly-backup 2>/dev/null
sudo docker volume rm instantly-db_backup-data 2>/dev/null   # если был
```

## Сервисы и их зависимости от Instantly env-переменных

| Сервис | INSTANTLY_DATABASE_URL | INSTANTLY_SUPABASE_URL | Комментарий |
|---|---|---|---|
| portal | Да (миграции) | Да (PostgREST) | Основной потребитель |
| worker-instantly-leads | Нет | Да (PostgREST) | Квалификация лидов |
| instantly-sync-bot | Да (asyncpg) | Нет | Прямой pg |
| health-check | Нет | Нет | Не использует Instantly |
