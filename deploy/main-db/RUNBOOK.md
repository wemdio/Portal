# Перенос основной БД Portal: Supabase → self-hosted Postgres

**DB-хост:** тот же, где instantly-db (IP: `144.31.54.166`)  
**Порт main-postgres:** `35434`  
**Даунтайм:** 5–15 минут (только шаг 5 — cutover)

---

## Шаг 0: Подготовка .env на DB-сервере

SSH на DB-сервер и добавь переменные в `/opt/instantly-db/.env`:

```bash
# Добавить в конец /opt/instantly-db/.env:
MAIN_PG_PASSWORD=<придумай надёжный пароль>
MAIN_PGADMIN_EMAIL=admin@portal.com
MAIN_PGADMIN_PASSWORD=<пароль для pgAdmin>
```

## Шаг 1: Поднять main-postgres на DB-сервере

```bash
ssh root@144.31.54.166

cd /opt/instantly-db

# Скопируй обновлённые файлы с локалки (или через CI):
#   docker-compose.yml, backup.sh, crontab, Dockerfile.backup

# Поднять только новый контейнер (instantly не трогается):
docker compose -p instantly-db --env-file .env up -d main-postgres main-pgadmin

# Проверить:
docker ps --filter name=main-postgres --format "table {{.Names}}\t{{.Status}}"
docker exec main-postgres psql -U portal -d portal -c "SELECT 1;"
```

## Шаг 2: Открыть порт 35434 для Portal-сервера

Убедиться, что firewall разрешает подключение с Portal-сервера к порту 35434.  
Проверка с Portal-сервера:

```bash
ssh root@<PORTAL_HOST>
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/144.31.54.166/35434' && echo OK || echo BLOCKED
```

## Шаг 3: Первичный дамп (preload) — БЕЗ даунтайма

Выполняется заранее. Portal продолжает работать со старой Supabase БД.

```bash
ssh root@144.31.54.166

# Запустить из контейнера postgres (там есть pg_dump/pg_restore):
docker exec -it main-postgres bash

# Внутри контейнера:
pg_dump \
  --host=db.pwcidzaqudfkodgmesyk.supabase.co \
  --port=5432 \
  --username=postgres \
  --dbname=postgres \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --exclude-schema='supabase_*' \
  --exclude-schema='_supavisor' \
  --exclude-schema='_realtime' \
  --exclude-schema='_analytics' \
  --exclude-schema='auth' \
  --exclude-schema='storage' \
  --exclude-schema='graphql*' \
  --exclude-schema='pgsodium*' \
  --exclude-schema='vault' \
  --exclude-schema='pgbouncer' \
  --exclude-schema='net' \
  --exclude-schema='extensions' \
  --file=/tmp/portal-preload.dump

# Восстановить в main-postgres:
pg_restore \
  --host=127.0.0.1 \
  --port=5432 \
  --username=portal \
  --dbname=portal \
  --no-owner \
  --no-privileges \
  --if-exists \
  --clean \
  /tmp/portal-preload.dump || echo "Warnings above are normal on first restore"

# Проверить:
psql -U portal -d portal -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 15;"

exit
```

> **Пароль Supabase Postgres:** найти в Supabase Dashboard → Settings → Database → Connection string.  
> Задать перед pg_dump: `export PGPASSWORD='<supabase_db_password>'`

## Шаг 4: Применить миграции

После pg_restore в новой БД уже есть все таблицы. Но чтобы `ensureDatabase.js` не пытался повторно применить миграции, нужно убедиться, что таблица `portal_migrations` заполнена.

Она уже перенесётся из дампа, если была в Supabase. Проверить:

```bash
docker exec main-postgres psql -U portal -d portal \
  -c "SELECT count(*) FROM portal_migrations;"
```

Если таблицы нет (Portal раньше не трекал миграции в таблице) — не страшно, `ensureDatabase.js` создаст её и применит все файлы из `supabase/migrations/`. Они идемпотентны (`IF NOT EXISTS`).

## Шаг 5: Cutover (даунтайм 5–15 мин)

### 5a. Повторный быстрый дамп (delta)

```bash
ssh root@144.31.54.166

# Внутри main-postgres:
docker exec -it main-postgres bash

export PGPASSWORD='<supabase_db_password>'
pg_dump \
  --host=db.pwcidzaqudfkodgmesyk.supabase.co \
  --port=5432 \
  --username=postgres \
  --dbname=postgres \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --exclude-schema='supabase_*' \
  --exclude-schema='_supavisor' \
  --exclude-schema='_realtime' \
  --exclude-schema='_analytics' \
  --exclude-schema='auth' \
  --exclude-schema='storage' \
  --exclude-schema='graphql*' \
  --exclude-schema='pgsodium*' \
  --exclude-schema='vault' \
  --exclude-schema='pgbouncer' \
  --exclude-schema='net' \
  --exclude-schema='extensions' \
  --file=/tmp/portal-final.dump

pg_restore \
  --host=127.0.0.1 \
  --port=5432 \
  --username=portal \
  --dbname=portal \
  --no-owner \
  --no-privileges \
  --if-exists \
  --clean \
  /tmp/portal-final.dump || true

exit
```

### 5b. Переключить Portal на новую БД

```bash
ssh root@<PORTAL_HOST>
cd /home/Portal/prod

# Удалить старые строки и добавить новые:
sed -i '/^DATABASE_URL=/d;/^SUPABASE_DB_URL=/d' .env

cat >> .env <<'EOF'
DATABASE_URL=postgresql://portal:<MAIN_PG_PASSWORD>@144.31.54.166:35434/portal?sslmode=disable
SUPABASE_DB_URL=postgresql://portal:<MAIN_PG_PASSWORD>@144.31.54.166:35434/portal?sslmode=disable
EOF

# Проверить:
grep -nE '^DATABASE_URL=|^SUPABASE_DB_URL=' .env

# Перезапустить Portal и воркеры:
docker compose -p portal -f docker-compose.prod.yml up -d --force-recreate portal
docker compose -p portal -f docker-compose.prod.yml up -d --force-recreate \
  worker-hh worker-search worker-enrich worker-yandexmaps \
  worker-emailvalidation worker-tg-outreach worker-aicaller \
  worker-sales-copilot worker-tg-parser worker-tg-transcribe \
  worker-instantly-leads worker-outreach

# Проверить логи:
docker logs --tail=50 portal
```

### 5c. Проверить, что Portal работает

- Открыть Portal в браузере
- Проверить, что данные на месте
- Проверить логи на ошибки: `docker logs --tail=200 portal 2>&1 | grep -i error`

## Rollback (если что-то пошло не так)

```bash
ssh root@<PORTAL_HOST>
cd /home/Portal/prod

# Вернуть старые URL:
sed -i '/^DATABASE_URL=/d;/^SUPABASE_DB_URL=/d' .env

cat >> .env <<'EOF'
DATABASE_URL=postgresql://postgres.pwcidzaqudfkodgmesyk:<SUPABASE_PASSWORD>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
SUPABASE_DB_URL=postgresql://postgres.pwcidzaqudfkodgmesyk:<SUPABASE_PASSWORD>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
EOF

docker compose -p portal -f docker-compose.prod.yml up -d --force-recreate portal
docker compose -p portal -f docker-compose.prod.yml up -d --force-recreate \
  worker-hh worker-search worker-enrich worker-yandexmaps \
  worker-emailvalidation worker-tg-outreach worker-aicaller \
  worker-sales-copilot worker-tg-parser worker-tg-transcribe \
  worker-instantly-leads worker-outreach
```

---

## Бэкапы

После переключения пересобрать контейнер бэкапов:

```bash
ssh root@144.31.54.166
cd /opt/instantly-db
docker compose -p instantly-db --env-file .env up -d --build instantly-backup
```

Main DB будет бэкапиться каждые 4 часа (crontab).
