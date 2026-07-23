# instantly-db-prod — перенос Instantly-баз со 144 на прод (139)

> Статус на 22.07.2026: боевое переключение завершено; Instantly prod/dev и
> `instantly_dataset` работают на `139.60.162.12`. Хост `144.31.54.166` временно
> сохраняется только для rollback и вспомогательных сервисов. Ниже оставлена
> история и процедура переезда.

Второй этап переезда БД (первый — main-supabase, см. `deploy/main-db-prod/`).
Контекст: memory `db-migration-to-prod` (18.07.2026).

**Compose НЕ форкается**: прод использует ровно `deploy/instantly-db/docker-compose.yml`
(секция main-postgres под profile `main-db` не активируется — обычный `up -d` её
не стартует). CI (`.semaphore/scheduled-deploy.yml`) уже деплоит этот стек на хост
из Semaphore-переменной `INSTANTLY_DB_SSH_HOST` — после переезда достаточно
поменять в ней 144.31.54.166 → 139.60.162.12.

Здесь только скрипты переезда:
- `dump-instantly.sh` — запускается НА 144: globals (роли instantly + dataset_ro
  с паролями) + дампы instantly (79MB) / instantly_dataset (12GB) / dev (9MB).
- `restore-instantly.sh` — на проде, в СВЕЖЕподнятые контейнеры баз (только базы,
  без migrator — см. шапку скрипта).
- `verify-instantly.sh` — проверка: размеры, роли, счётчики датасета, PostgREST.

Обе стороны — postgres:16-alpine: конфликта версий дампа (грабли main) нет.

## Репетиция (днём, без простоя)

1. 144: `bash dump-instantly.sh` (~15–25 мин, онлайн).
2. прод: скопировать конфиги со 144 (`/opt/instantly-db`: docker-compose.yml, .env,
   migrations/, scripts/) и дампы (`/root/instantly-dumps`) — заодно замеряется
   скорость WAN 144→139 (нужна для окна боевой ночи main).
3. прод: `cd /opt/instantly-db && docker compose up -d instantly-postgres-prod
   instantly-postgres-dev` → `restore-instantly.sh` → `docker compose up -d` →
   `verify-instantly.sh`.

## Боевое переключение (в ту же ночь, что и main)

1. Остановлен прод-стек приложения (уже — ради main) + не идёт ночной синк
   instantly-sync-bot (проверить время его крона).
2. Свежий dump-instantly.sh на 144 → scp → на проде `down -v` instantly-стека →
   up баз → restore → полный up → verify.
3. Переключение конфигов:
   - прод `.env` приложения: в `INSTANTLY_DATABASE_URL`, `INSTANTLY_DEV_DATABASE_URL`,
     `INSTANTLY_SUPABASE_URL` (порт 35401), `INSTANTLY_DATASET_DB_URL` — хост
     144.31.54.166 → 139.60.162.12;
   - Semaphore: `INSTANTLY_DB_SSH_HOST` → 139.60.162.12 (креды SSH прода);
   - локальный `.env` разработчика (wiki-сессии ходят по `INSTANTLY_DATASET_DB_URL`);
   - упоминания 144 в `wiki/CLAUDE.md` при следующей правке.
4. Смоук: Автоотчёты (список кампаний — PostgREST), запрос в датасет.
5. Откат: вернуть хосты в `.env`. Базы на 144 не менялись.

## После полного переезда (обе фазы)

На 144 остаются: pgadmin-админки, smtp-proxy, openclaw-gateway, мониторинг —
решить их судьбу отдельно; сервер можно будет со временем гасить.
