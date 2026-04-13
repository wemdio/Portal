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

- Prod: каждые 6 часов, загрузка в Supabase Storage `deploy-backups/instantly/prod/`
- Dev: раз в сутки (03:00 UTC), `deploy-backups/instantly/dev/`
- Локальная ротация: 7 дней (настраивается через `BACKUP_RETENTION_DAYS`)

Восстановление из бэкапа:

```bash
# Скачать дамп из Supabase Storage (или взять локальный из /backups/)
docker exec -i instantly-postgres-prod pg_restore \
  -U instantly -d instantly --clean --if-exists < instantly-prod-YYYYMMDD_HHMMSS.dump
```

## Сервисы и их зависимости от Instantly env-переменных

| Сервис | INSTANTLY_DATABASE_URL | INSTANTLY_SUPABASE_URL | Комментарий |
|---|---|---|---|
| portal | Да (миграции) | Да (PostgREST) | Основной потребитель |
| worker-instantly-leads | Нет | Да (PostgREST) | Квалификация лидов |
| instantly-sync-bot | Да (asyncpg) | Нет | Прямой pg |
| health-check | Нет | Нет | Не использует Instantly |
