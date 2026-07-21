# Перенос Portal с Supabase Cloud на self-hosted стек

> Архивный runbook первой миграции (Supabase Cloud → `144.31.54.166`). После
> cutover 22.07.2026 текущий production DB-хост — `139.60.162.12`; команды и адреса
> ниже сохранены как история и не должны использоваться для нового развёртывания.

**Цель:** уйти с Supabase Cloud на свой хост (тот же, где `instantly-db`),
с минимальными правками в коде Portal (меняем только URL/ключи в `.env`).

**DB-хост:** `144.31.54.166`  
**Новый Supabase API URL:** `http://144.31.54.166:35480` (Kong)  
**main-postgres:** `144.31.54.166:35434` (для прямых подключений + миграций)  
**Даунтайм:** 15-30 мин на cutover (Шаг 6).

---

## Что переносится

| Компонент | Что | Где живёт после |
|-----------|-----|-----------------|
| `public` schema (~125 таблиц) | весь код приложения | `main-postgres` |
| `auth` schema (users, sessions, identities) | пользователи и логины | `main-postgres` + GoTrue |
| `storage` schema (buckets, objects metadata) | метаданные файлов | `main-postgres` + Storage API |
| Файлы Storage (~7 бакетов) | бинарники | local filesystem на DB-хосте, под Storage API |
| JWT secret | подпись токенов | `MAIN_JWT_SECRET` в `/opt/main-db/.env` |

## Что **не** переносится / новое

- pgsodium / vault — у нас нет секретов в Supabase Vault (проверить `select * from vault.secrets`)
- Edge Functions — приложение не использует
- Analytics / Logflare — не используется

---

## Шаг 0: Сгенерировать ключи (на локалке)

Решить, **сохранять старый JWT_SECRET или нет**:

- **Сохранить** = после cutover все залогиненные пользователи останутся залогинены.  
  Берём JWT secret из Supabase Dashboard → Project Settings → API → "JWT Settings" → JWT Secret.
- **Сгенерировать новый** = все пользователи разлогинены (придётся ввести пароль).  
  Безопаснее (на случай если старый секрет утёк).

```bash
# Вариант A: сохранить старый
node deploy/main-db/scripts/generate-keys.mjs --secret='<old_jwt_secret_from_supabase>'

# Вариант B: новый
node deploy/main-db/scripts/generate-keys.mjs
```

Скрипт выведет блок переменных. Сохрани вывод — он понадобится в шагах 2 и 6.

---

## Шаг 1: Обновить `/opt/instantly-db/.env` на DB-сервере

```bash
ssh root@144.31.54.166

cd /opt/instantly-db
# Если есть старый MAIN_PG_PASSWORD — проверь, что он матчит то, что планируешь дальше.
# Если нет — добавь его (он же будет для всех Supabase сервисов).

cat >> .env <<'EOF'
# Главный пароль Postgres (используется и Supabase сервисами)
MAIN_PG_PASSWORD=<тот же пароль, что в /opt/main-db/.env>
# JWT для встроенного в supabase/postgres ENV (используется pgjwt extension)
MAIN_JWT_SECRET=<вывод generate-keys.mjs>
# 21600 = 6 часов. Старое значение 3600 (1 час) приводило к выкидыванию
# с портала каждый час при переходе по вкладкам.
MAIN_JWT_EXP=21600
EOF

sed -i 's/\r$//' .env
```

## Шаг 2: Пересоздать main-postgres на supabase/postgres

> ВАЖНО: меняется image (postgres:16-alpine → supabase/postgres:15.8.1.060) и volume
> (`main-pg-data` → `main-supabase-pg-data`). Если в старом volume уже что-то было — оно
> не пропадёт, просто не будет использоваться. Можно удалить позже.

Скопировать обновлённые файлы с локалки:

```bash
scp -r deploy/instantly-db/docker-compose.yml \
       deploy/instantly-db/main-init \
       root@144.31.54.166:/opt/instantly-db/
```

На DB-сервере:

```bash
ssh root@144.31.54.166
cd /opt/instantly-db

# Снять старый main-postgres (если он был запущен)
docker compose -p instantly-db --profile main-db --env-file .env down main-postgres main-pgadmin || true

# Поднять заново на supabase/postgres
docker compose -p instantly-db --profile main-db --env-file .env up -d main-postgres main-pgadmin

# Дождаться готовности
docker compose -p instantly-db --profile main-db --env-file .env logs -f main-postgres
# Жди строк "database system is ready to accept connections" + "init script ... completed"
# Ctrl+C когда увидишь
```

Проверить, что схемы и роли подняты:

```bash
docker exec -it main-postgres psql -U supabase_admin -d postgres -c "\dn" \
  | grep -E '(auth|storage|realtime|extensions|graphql|pgsodium|vault)'
docker exec -it main-postgres psql -U supabase_admin -d postgres -c "\du" \
  | grep -E '(anon|authenticated|service_role|supabase_)'
docker exec -it main-postgres psql -U supabase_admin -d postgres -c "\dx" \
  | grep -E '(pgcrypto|pgjwt|pgvector|pg_cron|pgsodium|supabase_vault)'
```

## Шаг 3: Развернуть Supabase-стек (Kong, GoTrue, PostgREST, Storage, Realtime)

```bash
# С локалки:
scp -r deploy/main-db root@144.31.54.166:/opt/

# На сервере:
ssh root@144.31.54.166
cd /opt/main-db

# Создать .env по шаблону
cp .env.example .env
# Вставить туда: MAIN_PG_PASSWORD, MAIN_JWT_SECRET, MAIN_ANON_KEY, MAIN_SERVICE_ROLE_KEY,
# MAIN_REALTIME_DB_ENC_KEY, MAIN_REALTIME_SECRET_KEY_BASE из generate-keys.mjs.
# А также MAIN_API_EXTERNAL_URL=http://144.31.54.166:35480 (или твой публичный URL).
nano .env
sed -i 's/\r$//' .env

# Поднять стек
docker compose -p main-supabase --env-file .env up -d

# Подождать healthchecks
sleep 15
docker compose -p main-supabase ps
```

Проверка снаружи:

```bash
# С Portal-сервера:
curl -i http://144.31.54.166:35480/auth/v1/health -H "apikey: <MAIN_ANON_KEY>"
curl -i http://144.31.54.166:35480/rest/v1/ -H "apikey: <MAIN_ANON_KEY>"
# 401/200 — оба ОК (они как минимум отвечают)
```

## Шаг 4: Открыть порт 35480 (Kong) для Portal-сервера

С Portal-сервера:

```bash
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/144.31.54.166/35480' && echo OK || echo BLOCKED
```

## Шаг 5: PRELOAD — первичный дамп БЕЗ даунтайма

Portal продолжает работать на Supabase Cloud. Делаем первый проход переноса.

```bash
ssh root@144.31.54.166
cd /opt/main-db

# Скопировать пароль Supabase из Dashboard → Settings → Database
docker exec -it main-postgres bash -c "
  apt-get update -qq && apt-get install -y -qq curl
"

# Скопировать скрипт миграции в контейнер
docker cp /opt/main-db/migrate-from-supabase.sh main-postgres:/tmp/migrate-from-supabase.sh

# Запустить миграцию schema + данных
docker exec -it main-postgres bash -c "
  export SOURCE_HOST=db.pwcidzaqudfkodgmesyk.supabase.co
  export SOURCE_PORT=5432
  export SOURCE_USER=postgres
  export SOURCE_PASSWORD='<supabase_db_password>'
  export TARGET_PASSWORD='<MAIN_PG_PASSWORD>'
  bash /tmp/migrate-from-supabase.sh
"
```

Перенос файлов Storage (можно одновременно с pg_dump в другом терминале):

```bash
# С локалки или с DB-сервера, нужен node 18+
SOURCE_SUPABASE_URL=https://pwcidzaqudfkodgmesyk.supabase.co \
SOURCE_SERVICE_ROLE_KEY='<old service_role key из Supabase>' \
TARGET_SUPABASE_URL=http://144.31.54.166:35480 \
TARGET_SERVICE_ROLE_KEY='<MAIN_SERVICE_ROLE_KEY>' \
  node deploy/main-db/migrate-storage-files.mjs --concurrency=8

# Сначала dry-run, чтобы увидеть масштаб:
# ... node ... migrate-storage-files.mjs --dry-run
```

## Шаг 6: CUTOVER (даунтайм)

### 6a. Включить maintenance mode на Portal

```bash
ssh root@<PORTAL_HOST>
cd /home/Portal/prod
# Workers и Portal остановим в 6c — не сейчас, чтобы успеть обновить .env.
```

### 6b. Финальный delta-дамп

```bash
ssh root@144.31.54.166
docker exec -it main-postgres bash -c "
  export SOURCE_HOST=db.pwcidzaqudfkodgmesyk.supabase.co
  export SOURCE_PORT=5432
  export SOURCE_USER=postgres
  export SOURCE_PASSWORD='<supabase_db_password>'
  export TARGET_PASSWORD='<MAIN_PG_PASSWORD>'
  bash /tmp/migrate-from-supabase.sh
"

# И delta для файлов
SOURCE_SUPABASE_URL=https://pwcidzaqudfkodgmesyk.supabase.co \
SOURCE_SERVICE_ROLE_KEY='<old service_role>' \
TARGET_SUPABASE_URL=http://144.31.54.166:35480 \
TARGET_SERVICE_ROLE_KEY='<MAIN_SERVICE_ROLE_KEY>' \
  node deploy/main-db/migrate-storage-files.mjs --skip-existing --concurrency=8
```

### 6c. Переключить .env на Portal-сервере

```bash
ssh root@<PORTAL_HOST>
cd /home/Portal/prod

# Снять текущие значения
sed -i '/^NEXT_PUBLIC_SUPABASE_URL=/d' .env
sed -i '/^NEXT_PUBLIC_SUPABASE_ANON_KEY=/d' .env
sed -i '/^SUPABASE_SERVICE_ROLE_KEY=/d' .env
sed -i '/^SUPABASE_DB_URL=/d' .env
sed -i '/^DATABASE_URL=/d' .env

# Прописать новые
cat >> .env <<'EOF'
NEXT_PUBLIC_SUPABASE_URL=http://144.31.54.166:35480
NEXT_PUBLIC_SUPABASE_ANON_KEY=<MAIN_ANON_KEY>
SUPABASE_SERVICE_ROLE_KEY=<MAIN_SERVICE_ROLE_KEY>
DATABASE_URL=postgresql://supabase_admin:<MAIN_PG_PASSWORD>@144.31.54.166:35434/postgres?sslmode=disable
SUPABASE_DB_URL=postgresql://supabase_admin:<MAIN_PG_PASSWORD>@144.31.54.166:35434/postgres?sslmode=disable
EOF

grep -nE '^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|SUPABASE_DB_URL)=' .env
```

### 6d. Перезапустить Portal + workers + python-боты

```bash
docker compose -p portal -f docker-compose.prod.yml up -d --no-deps --force-recreate \
  portal yandexmaps transcribe-worker telegram-bot-api health-check atmos-bot \
  instantly-sync-bot

docker compose -p portal -f docker-compose.prod.yml up -d --no-deps --force-recreate \
  worker-hh worker-search worker-enrich worker-yandexmaps \
  worker-emailvalidation worker-tg-outreach worker-aicaller \
  worker-sales-copilot worker-tg-parser worker-tg-transcribe \
  worker-instantly-leads worker-outreach worker-li-outreach

docker logs --tail=80 portal 2>&1
docker logs --tail=80 portal-health-check 2>&1
docker logs --tail=80 portal-instantly-sync-bot 2>&1
```

### 6e. Smoke-тест

| Проверка | Как |
|---|---|
| Главная грузится | открыть Portal в браузере |
| Login работает | разлогиниться, залогиниться |
| Список пользователей в админке | `/admin/users` |
| Storage upload | загрузить файл в KB или brief |
| Storage download | скачать существующий файл |
| Realtime | открыть admin/logs или admin/traces — данные апдейтятся |
| Worker подбирает задачу | запустить любой парсер |
| `/api/health` | `curl https://portal.example.com/api/health` |

---

## Rollback (если что-то отвалилось критически)

```bash
ssh root@<PORTAL_HOST>
cd /home/Portal/prod

# Снять новые значения
sed -i '/^NEXT_PUBLIC_SUPABASE_URL=/d' .env
sed -i '/^NEXT_PUBLIC_SUPABASE_ANON_KEY=/d' .env
sed -i '/^SUPABASE_SERVICE_ROLE_KEY=/d' .env
sed -i '/^SUPABASE_DB_URL=/d' .env
sed -i '/^DATABASE_URL=/d' .env

# Вернуть старые (записи Supabase Cloud — найди в .env.backup или Semaphore Secrets)
cat >> .env <<'EOF'
NEXT_PUBLIC_SUPABASE_URL=https://pwcidzaqudfkodgmesyk.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<old anon key>
SUPABASE_SERVICE_ROLE_KEY=<old service_role key>
DATABASE_URL=postgresql://postgres.pwcidzaqudfkodgmesyk:<old_pwd>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
SUPABASE_DB_URL=postgresql://postgres.pwcidzaqudfkodgmesyk:<old_pwd>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
EOF

# Перезапуск (см. 6d)
```

Данные, которые юзеры записали ПОСЛЕ cutover, останутся в self-hosted и не вернутся в Cloud.
Поэтому при rollback окно операции должно быть очень коротким.

---

## После успешного cutover (T+24-48 ч)

1. Заморозить (или удалить) проект в Supabase Cloud Dashboard.
2. Удалить из `.env` старые ключи (не нужны).
3. Удалить старый volume `main-pg-data` (от postgres:16-alpine):
   ```bash
   docker volume rm instantly-db_main-pg-data 2>/dev/null || true
   ```
4. Настроить бэкапы — `portal-backup` на Portal-сервере уже бэкапит main-supabase
   и Instantly через `MAIN_SUPABASE_DATABASE_URL` / `INSTANTLY_DATABASE_URL`
   (см. `docs/instantly-local-pg-cutover.md` → «Автобэкапы»). Если переезжаешь
   на self-hosted main-postgres — поменяй `MAIN_SUPABASE_DATABASE_URL` на
   локальный URL (`postgresql://supabase_admin:<pw>@<DB_HOST>:35434/postgres`).
5. **Storage файлы**: они лежат на DB-хосте в named volume `main-supabase_main-storage-data`.
   Включить их в бэкап-сценарий (например, `tar` + upload в S3).

---

## Возможные грабли

- **`auth restore` падает с дубликатами** — нормально, если запускаешь второй раз. Используй
  опцию `--data-only --disable-triggers` (она уже в скрипте).
- **`storage.objects` пустые после restore, но файлы есть** — проверь, что переносишь оба:
  и таблицу (через pg_dump), и бинарники (через `migrate-storage-files.mjs`).
- **Portal жалуется на CORS** — проверь `MAIN_API_EXTERNAL_URL` и `MAIN_SITE_URL` в .env.
- **GoTrue не находит юзеров** — проверь, что роли в БД корректные:
  `select * from auth.users limit 1` под `supabase_auth_admin`.
- **Realtime не работает** — Postgres должен быть в режиме `wal_level=logical`.
  В `supabase/postgres` это уже включено по умолчанию.
- **`pg_cron` не работает** — расширение работает только в БД `postgres` (а не `portal`).
  В нашем init скрипте мы используем именно `postgres`.

---

## Изменение TTL сессии (access/refresh)

По умолчанию access-токен GoTrue живёт 1 час, что приводит к выкидыванию
пользователей с портала (видно как редирект на `/login` при переходе по
вкладкам). Текущие значения в `deploy/main-db/.env.example`:

| Переменная | Значение | Что делает |
|------------|----------|-----------|
| `MAIN_JWT_EXP` | `21600` (6 ч) | TTL access-токена (`GOTRUE_JWT_EXP`, `PGRST_APP_SETTINGS_JWT_EXP`, и `JWT_EXP` у `main-postgres`). |
| `MAIN_SESSIONS_INACTIVITY_TIMEOUT` | `604800s` (7 дн) | Refresh выкидывается, если им не пользовались N времени (`GOTRUE_SESSIONS_INACTIVITY_TIMEOUT`). У активного юзера обновляется на каждом авто-рефреше. |

### Как раскатить на проде

```bash
# DB-хост (там, где self-hosted Supabase):
ssh root@144.31.54.166

cd /opt/main-db
# 1. Поправить значения в .env
sed -i 's/^MAIN_JWT_EXP=.*/MAIN_JWT_EXP=21600/' .env
grep -q '^MAIN_SESSIONS_INACTIVITY_TIMEOUT=' .env \
  || echo 'MAIN_SESSIONS_INACTIVITY_TIMEOUT=604800s' >> .env

# 2. Пересоздать только GoTrue, REST и main-postgres (БД-volume сохранится)
docker compose -p main-supabase --env-file .env up -d --force-recreate auth rest

# Postgres-контейнер живёт в /opt/instantly-db (там же main-postgres):
cd /opt/instantly-db
sed -i 's/^MAIN_JWT_EXP=.*/MAIN_JWT_EXP=21600/' .env
docker compose -p instantly-db --env-file .env up -d --force-recreate main-postgres
```

После этого новые токены, которые GoTrue выдаёт, будут жить 6 часов.
Существующие сессии останутся валидными (refresh-токены продолжат работать),
ничего пересоздавать у пользователей не нужно — они просто перестанут так
часто упираться в редирект на `/login`.
