# Portal repo — AI agent entrypoint

Этот файл подгружается Claude Code автоматически в начале каждой сессии.

Перед любыми действиями с Git, релизом или production обязательно прочитай и соблюдай [`AGENTS.md`](./AGENTS.md). Раздел про границы релиза и production — критический.

## Что это за репозиторий

Portal — внутренний инструмент студии: Next.js app, воркеры и production-БД на prod-сервере, интеграция с Instantly для cold outreach. Инфраструктура описана в [`.env.servers`](./.env.servers) (НЕ коммитить).

- Прод: `139.60.162.12` (Next.js, workers, main Supabase/Postgres, два instantly-postgres, analytics-датасет `instantly_dataset`, instantly-sync-bot, qualifier и т.д.)
- Старый DB/utility-сервер: `144.31.54.166` (временные rollback-копии после переезда и вспомогательные сервисы; не использовать как текущий endpoint БД)

Документация и архитектура: [README.md](./README.md), [DESIGN.md](./DESIGN.md), [PRODUCT.md](./PRODUCT.md).

## Когда работаешь с Instantly-датасетом (analytics, AI-агент по outreach данным)

**Сразу читай [`wiki/CLAUDE.md`](./wiki/CLAUDE.md)** — там полный контекст:
- структура `instantly_dataset` (23 таблицы + 6 lookup + 6 views, 2.1M+ писем (растёт еженощно), 167K лидов)
- паттерн `wiki/` для накопления знаний (Karpathy LLM-wiki)
- **обязательный self-improving eval loop**: каждая сессия логируется в `query_log`, раз в неделю ревьюим и улучшаем датасет/wiki (YC-style)

Связь и креды к датасету — в `.env` под `INSTANTLY_DATASET_DB_URL`.

## Когда работаешь с самим portal-приложением (Next.js, воркеры, миграции основной БД)

Это вне scope wiki — обычная разработка. Используй стандартные практики проекта.
- App код: `app/src/`
- Скрипты: `app/scripts/`
- Миграции основной БД: `supabase/migrations/`, `supabase/instantly-migrations/`
- Миграции аналитического датасета: `app/scripts/instantly-dataset/00*_*.sql`

### Как деплоится ночной синк датасета (`app/scripts/instantly-dataset/`)

Синк живёт **вне** compose приложения: `/opt/instantly-dataset-sync` на 139, крон `docker run node:22-alpine node sync.mjs` в 00:00 МСК. Два пути на прод:
- **Код** (`sync.mjs`, лейблеры, `sync-portal-mirror.mjs`, `*.sql`) — автодеплой из main (`.semaphore/scheduled-deploy.yml`, шаг «Dataset sync»): триггер — изменения в `app/scripts/instantly-dataset/*` (кроме `wiki/`), `node --check` в образе крона, прежняя версия в `.prev/`, при ошибке приложение деплоится штатно, а в health-чат летит алерт и прогон красный. Список файлов в шаге должен совпадать с `deploy-sync.sh`.
- **Конфиг** (`.env` синка, crontab, `npm install`) и хотфиксы до мержа — руками `app/scripts/instantly-dataset/deploy-sync.sh` (см. шапку: он пересобирает прод-`.env` из локального — сверь `INSTANTLY_DATASET_DB_URL`).
- Доки для специалистов (`app/scripts/instantly-dataset/wiki/*.md`) → `node app/scripts/instantly-dataset/load-agent-wiki.mjs` (пишет в `agent_wiki` датасета).

## Что НЕ делать

- Не коммитить `.env*` файлы — там креды.
- Не дёргать Instantly /emails API больше 10 RPM пока `portal-worker-instantly-leads` контейнер запущен на prod — общий workspace rate limit, [инцидент 22 мая в `wiki/log.md`](./wiki/log.md).
- Не модифицировать `query_log` строки post-hoc для подкрутки метрик loop'a. Loop работает только если данные честные.

## Правило: после правки compose обязателен `--force-recreate`

**Любая правка `docker-compose*.yml`** (`docker-compose.prod.yml`, `deploy/main-db-prod/docker-compose.yml`, `deploy/instantly-db/docker-compose.yml`) требует **явного** пересоздания затронутых сервисов:

```bash
docker compose -p <project> -f <file> up -d --force-recreate --no-deps <service1> <service2>
```

Без `--force-recreate` Docker хранит конфигурацию контейнера в собственной БД с момента `create` и при рестарте берёт её оттуда, а не читает compose. Правки лежат мёртвым грузом до пересоздания.

**Особенно критично для полей** `healthcheck`, `deploy.resources.limits`, `restart` — compose diff-detection иногда их пропускает.

**Прецедент 23.07.2026:** правка `healthcheck: disable: true` для двух distroless postgrest контейнеров была сделана 22.07, но `--force-recreate` не запустили → 15 часов loop failed exec → миллионы closed FIFO в dockerd → hang сервера. Post-mortem — коммит `f4cc524e`.

## Post-mortem от 23.07.2026 — что защищает от повторения

Уровни защиты, применённые после hang'а сервера:

1. **`/etc/docker/daemon.json` на 139** — log rotation (50 MB × 3 файла на контейнер) + `live-restore: true` (рестарт docker без падения контейнеров) + `nofile: 1M`.
2. **`/etc/systemd/journald.conf` на 139** — `SystemMaxUse=10G`, `RateLimitBurst=10000/30s` — journal не съест диск, спам-контейнер обрезается на уровне журнала.
3. **`services/health-check/main.py`** — TG-алерт при broken healthcheck (Health.Status=unhealthy + FailingStreak ≥ 20) с типом причины + pids ≥ 80% cgroup-лимита.
4. **compose fixes**: `localhost` → `127.0.0.1` в healthcheck main-storage и portal-telegram-bot-api (IPv6 fallback → refused при IPv4-only сервисе).

TODO: pids-лимит `pids: 512` во все compose-сервисы (защита от fork-bomb на cgroup-уровне) — отдельный PR.
