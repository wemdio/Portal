# Cutover: Instantly Supabase → выделенный сервер PostgreSQL

## Архитектура

Instantly DB живёт на **отдельном сервере** от Portal, в `deploy/instantly-db/docker-compose.yml`.
Два инстанса (prod + dev) с отдельными pgAdmin и автобэкапами. На хосте используются **нестандартные порты** (не 5432/3001), чтобы не пересекаться с другими сервисами на том же сервере. Внутри Docker-сети Postgres по-прежнему на `5432`, PostgREST на `3000`.

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
Backup-контейнер начнёт делать pg_dump по расписанию (prod каждые 6ч, dev раз в сутки).

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
docker logs instantly-backup
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

Сервис `portal-backup` (контейнер на **Portal-сервере**, `services/backup/`,
образ `${DOCKER_USERNAME}/portal-backup:prod`) держит cron внутри себя и пишет
дампы в bucket `db-backups` Supabase Storage (имя задаётся через `BACKUP_BUCKET`,
дефолт `db-backups`). Один контейнер бэкапит и главную Supabase БД, и обе
Instantly-копии (prod + dev) — так все дампы и алерты живут в одном месте.

| Источник | Расписание (UTC) | Путь в Storage | Локальный ретеншн | Облачный ретеншн |
|----------|------------------|----------------|-------------------|------------------|
| Главная Supabase БД (`main-supabase`) | каждые 6 ч в `:15` | `db-backups/portal-main/` | 7 дней | 30 дней |
| Instantly local PG prod (`instantly-prod`) | каждые 6 ч в `:00` | `db-backups/instantly/prod/` | 7 дней | 30 дней |
| Instantly local PG dev (`instantly-dev`) | раз в сутки в `03:00` | `db-backups/instantly/dev/` | 7 дней | 30 дней |

Все дампы — `pg_dump --format=custom --compress=6 --no-owner --no-privileges`.
Для главной Supabase БД дополнительно исключаем супабейзовскую инфраструктуру
(`_supavisor`, `_realtime`, `_analytics`, `pgsodium`, `vault`, `supabase_*`,
`extensions`, `graphql*`, `cron`, `net`, `pgbouncer`) — это нужно, чтобы дамп
накатывался на чистый Postgres без managed-стека (`auth`, `storage`, `public`
сохраняются).

### Параметры в `/home/Portal/prod/.env`

`portal-backup` берёт URL подключения к БД **те же, что использует приложение**
(никаких параллельных PROD_PG_HOST/PASSWORD — DRY):

- `INSTANTLY_DATABASE_URL` — уже есть (Portal сам им пользуется).
- `INSTANTLY_DEV_DATABASE_URL` — опционально; если не задано, бэкап dev скипается.
- `MAIN_SUPABASE_DATABASE_URL` — **SESSION pooler URL** Supabase (порт **5432**,
  НЕ 6543 — transaction-pooler не поддерживает pg_dump). Если не задано —
  падает обратно на `DATABASE_URL`. Бери из Supabase Dashboard → Connect →
  Connection string → «Session pooler».

Куда грузим (по умолчанию — основной Supabase Portal, можно отдельный):

- `BACKUP_SUPABASE_URL` (default = `NEXT_PUBLIC_SUPABASE_URL`)
- `BACKUP_SUPABASE_KEY` (default = `SUPABASE_SERVICE_ROLE_KEY`)
- `BACKUP_BUCKET` (default `db-backups`) — bucket для дампов в Storage
- `BACKUP_RETENTION_DAYS` (default 7) — локальная ротация в named volume
- `BACKUP_REMOTE_RETENTION_DAYS` (default 30) — ротация в Storage

Telegram-алерты используют те же `TELEGRAM_HEALTH_BOT_TOKEN` /
`TELEGRAM_HEALTH_CHAT_ID`, что и `health-check`.

Bucket `db-backups` должен существовать в проекте `BACKUP_SUPABASE_URL`:
**Storage → New bucket → Private**, **Restrict file size = 2 GB** (или больше).
Глобальный лимит проекта: **Storage Settings → Global file size limit ≥ 2 GB**
(на Free поднять выше 50 МБ нельзя — нужен Pro). У `service_role` доступ есть
автоматически без RLS-политик.

История: ранее дампы лились в общий бакет `deploy-backups` (50 МБ лимит для
конфигов), что приводило к HTTP 400 на дампах главной БД (~830 МБ). Теперь
конфиги остались в `deploy-backups`, дампы БД — в отдельном `db-backups`.

### Алерты и чистка

Алерт уходит в Telegram при двух событиях:
1. `pg_dump` упал (ненулевой exit code)
2. `curl` upload в Supabase Storage вернул не-2xx

Текст алерта содержит `HTTP <code> rc=<curl_rc> size=<bytes>` — этого достаточно,
чтобы отличить серверную ошибку (`HTTP 4xx`/`5xx`, `rc=0`) от сетевой/таймаута
(`HTTP 000`, `rc=28`/`7`/...) и от OOM-kill самого curl (`HTTP=`, `rc=137`).

После успешного аплоада скрипт сам чистит старые объекты в Storage через
`POST /storage/v1/object/list/${BACKUP_BUCKET}` + `DELETE`. Чистка скипается,
если upload упал, чтобы не остаться без копии.

### Ручной запуск

```bash
# С Portal-сервера
docker exec portal-backup /backup.sh main-supabase    # главная БД
docker exec portal-backup /backup.sh instantly-prod   # Instantly prod
docker exec portal-backup /backup.sh instantly-dev    # Instantly dev
```

### Восстановление дампа на чистый Postgres

```bash
# 1) Скачать дамп из Supabase Storage
curl -fsSL -H "Authorization: Bearer ${BACKUP_SUPABASE_KEY}" \
  "${BACKUP_SUPABASE_URL}/storage/v1/object/db-backups/portal-main/portal-main-main-supabase-YYYYMMDD_HHMMSS.dump" \
  -o portal-main.dump

# 2) Поднять чистый Postgres
docker run -d --name pg-restore \
  -e POSTGRES_PASSWORD=temp \
  -p 5432:5432 \
  postgres:17-alpine

# 3) Для main-supabase ОДИН РАЗ создать расширения, которые могут встретиться
#    в дампе (auth/storage используют pgcrypto + uuid-ossp; vector — для embedding)
docker exec -i pg-restore psql -U postgres -d postgres <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
SQL

# 4) Накатить дамп
docker exec -i pg-restore pg_restore \
  -U postgres -d postgres \
  --clean --if-exists --no-owner --no-privileges \
  --jobs=4 < portal-main.dump

# Для Instantly БД расширений не нужно — там public схема и всё:
docker exec -i instantly-postgres-prod pg_restore \
  -U instantly -d instantly --clean --if-exists --no-owner --no-privileges \
  < instantly-instantly-prod-YYYYMMDD_HHMMSS.dump
```

### Тесты

Контракт `backup.sh` покрыт shell-тестами в `services/backup/test_backup.sh`
(нужен только bash; `pg_dump` и `curl` шиммируются через PATH; никаких внешних
зависимостей):

```bash
bash services/backup/test_backup.sh
# TESTS:   passed=45  failed=0
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
