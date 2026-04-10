# Cutover: Instantly Supabase → локальный PostgreSQL

## Предварительные условия

- Локальный `instantly-postgres` запущен и здоров (`docker compose up -d instantly-postgres`).
- Миграции `supabase/instantly-migrations/` применены (`node scripts/db/ensureDatabase.js`).
- `instantly-postgrest` запущен и доступен по `http://instantly-postgrest:3000`.
- Данные перенесены скриптом `migrate-instantly-to-local-pg.mjs` (full + delta).

## Новые env-переменные (.env на сервере)

```env
# Пароль для локального Postgres (используется в docker-compose)
INSTANTLY_PG_PASSWORD=<сгенерировать: openssl rand -base64 24>

# JWT-секрет для PostgREST (внутренний, не публичный)
INSTANTLY_JWT_SECRET=<сгенерировать: openssl rand -base64 32>

# Прямое подключение к локальному Postgres (для sync-bot, миграций, workers)
INSTANTLY_DATABASE_URL=postgresql://instantly:${INSTANTLY_PG_PASSWORD}@instantly-postgres:5432/instantly

# PostgREST URL (для supabaseInstantly в Next.js коде)
INSTANTLY_SUPABASE_URL=http://instantly-postgrest:3000

# Больше не нужен, но код ещё может проверять наличие:
INSTANTLY_SUPABASE_SERVICE_ROLE_KEY=local-no-supabase
```

## Порядок cutover

### 1. Подготовка (до окна обслуживания)

```bash
# Initial full load
INSTANTLY_SOURCE_DB_URL="postgresql://postgres.pwcidzaqudfkodgmesyk:<pass>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres" \
INSTANTLY_DATABASE_URL="postgresql://instantly:<pass>@127.0.0.1:5433/instantly" \
  node app/scripts/migrate-instantly-to-local-pg.mjs

# Verify counts
INSTANTLY_SOURCE_DB_URL="..." INSTANTLY_DATABASE_URL="..." \
  node app/scripts/migrate-instantly-to-local-pg.mjs --verify
```

### 2. Окно обслуживания (~5 мин)

```bash
# 2a. Остановить писателей в Instantly-таблицы
docker compose -p portal stop worker-instantly-leads instantly-sync-bot

# 2b. Финальная дельта-синхронизация
INSTANTLY_SOURCE_DB_URL="..." INSTANTLY_DATABASE_URL="..." \
  node app/scripts/migrate-instantly-to-local-pg.mjs --delta

# 2c. Финальная верификация
INSTANTLY_SOURCE_DB_URL="..." INSTANTLY_DATABASE_URL="..." \
  node app/scripts/migrate-instantly-to-local-pg.mjs --verify

# 2d. Обновить .env на сервере: заменить INSTANTLY_SUPABASE_URL и INSTANTLY_DATABASE_URL
#     на локальные значения (см. раздел «Новые env-переменные» выше)

# 2e. Перезапустить сервисы
docker compose -p portal -f docker-compose.prod.yml up -d --no-deps --force-recreate \
  portal worker-instantly-leads instantly-sync-bot
```

### 3. Smoke-checks после cutover

| Проверка | Команда / URL |
|---|---|
| Каталог кампаний | `GET /api/instantly/campaigns` — должен вернуть список |
| Квалификации лидов | `GET /api/instantly/qualified-leads` — должен вернуть данные |
| Webhook запись | `POST /api/instantly/events` с тестовым payload |
| Sync-бот | `docker logs portal-instantly-sync-bot --tail 50` — нет ошибок |
| agent_query_readonly | Telegram-бот → SQL-запрос к Instantly DB |
| Бриф | `GET /api/instantly/briefs` — список брифов |
| Клиентские лиды | `GET /api/client/leads` (с клиентским JWT) |

### 4. Rollback (если что-то пошло не так)

```bash
# Вернуть старые значения в .env:
#   INSTANTLY_SUPABASE_URL=https://pwcidzaqudfkodgmesyk.supabase.co
#   INSTANTLY_SUPABASE_SERVICE_ROLE_KEY=<old service role key>
#   INSTANTLY_DATABASE_URL=<old Supabase transaction pooler URL>

# Перезапустить:
docker compose -p portal -f docker-compose.prod.yml up -d --no-deps --force-recreate \
  portal worker-instantly-leads instantly-sync-bot
```

### 5. Отключение Supabase (через 24-48 часов без ошибок)

- Отключить или заморозить проект `pwcidzaqudfkodgmesyk` в Supabase Dashboard.
- Удалить `INSTANTLY_SOURCE_DB_URL` из .env (больше не нужен).
- Настроить регулярный бэкап volume `instantly-pg-data`:

```bash
# Ежедневный pg_dump через cron
docker exec portal-instantly-postgres pg_dump -U instantly instantly > /backup/instantly_$(date +%Y%m%d).sql
```

## Сервисы и их зависимости от Instantly env-переменных

| Сервис | INSTANTLY_DATABASE_URL | INSTANTLY_SUPABASE_URL | Комментарий |
|---|---|---|---|
| portal | Да (миграции) | Да (PostgREST) | Основной потребитель |
| worker-instantly-leads | Нет | Да (PostgREST) | Квалификация лидов |
| instantly-sync-bot | Да (asyncpg) | Нет | Прямой pg |
| health-check | Нет | Нет | Не использует Instantly |
