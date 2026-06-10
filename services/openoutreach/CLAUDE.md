# services/openoutreach — Portal-native fork

Этот каталог — **наш fork** OpenOutreach (см. [UPSTREAM.md](UPSTREAM.md)),
адаптированный под Portal'овскую multi-tenant Postgres-БД. Применяется
конвенция Portal'a (CLAUDE.md в корне репо), а не upstream'овская.

## Rules (override upstream rules)

- **Python env**: используй `.venv/bin/python` в этой директории. Для глобальной
  работы — обычный Portal'овский Python.
- **Commits**: следуем Portal-конвенции (см. корневой CLAUDE.md):
  - Russian-friendly multi-line messages с Why/How.
  - End with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` если коммит делал AI.
  - **НЕ** упстримовская «single-line только».
- **Dependencies**: `requirements/*.txt`. Добавляешь Python pkg — там же.
- **Docs sync**: при изменении кода обнови этот файл, `ARCHITECTURE.md`
  и при необходимости `UPSTREAM.md` (зона расхождения с upstream'ом).
- **Error handling**: app should crash on unexpected errors (upstream
  convention сохраняется). `try/except` только на expected, recoverable
  ошибки (CAPTCHA, AuthFail, NoSettings — см. `linkedin/portal_daemon/exceptions.py`).
- **No API backward compat**: переименовывай / удаляй / переписывай
  свободно — внешних потребителей фор`-а нет. Schema changes идут через
  Portal'овскую миграцию (`supabase/migrations/`), не Django.

## Project Overview

Multi-tenant OpenOutreach daemon: один Django-процесс обслуживает 5-20
LinkedIn-аккаунтов, каждый со своим Playwright Chromium (ephemeral, cap=3
одновременных). State в Portal Supabase, никакого SQLite. Деплоится одним
контейнером (`portal-openoutreach`) на основной прод (см. `docker-compose.prod.yml`).

## Commands

```bash
# Локальный dev (требует Postgres под рукой; для smoke без БД фоллбэк на SQLite)
make setup    # установка deps + playwright + миграции upstream apps
make run      # запуск daemon локально

# Docker
docker build -t portal-openoutreach -f compose/linkedin/Dockerfile .
# Polling localhost cookies-state через VNC (ENABLE_VNC=true в Dockerfile/compose):
docker run -p 6080:6080 -e DATABASE_URL=... portal-openoutreach

# Testing
pytest                                  # upstream pytest setup
pytest tests/api/test_voyager.py        # один файл
pytest -k test_name                     # один тест
```

## Architecture (quick reference)

### Portal-native bits (наши)

- **`li2/`** — Django app с Portal-native моделями. Все таблицы `li2_*`
  managed=False — owners схемы — Portal'овская миграция
  `supabase/migrations/20260610_0001`. Если хочется добавить колонку:
  сначала миграция в Portal'е, потом в `li2/models.py`.
- **`linkedin/portal_daemon/`** — наш multi-tenant daemon:
  - `main_loop.py` — поллит li2_accounts, dispatch'ит AccountWorker'ов
  - `account_worker.py` — per-account event loop, ephemeral Chromium
  - `browser_session.py` — Playwright context + Postgres storage_state
  - `executor.py` — task.type → handler с working_hours check
  - `handlers.py` — **STUB'ы** на момент 2026-06-10. Real Voyager/LLM impl —
    следующая итерация (см. inline TODO-комменты в файле).
  - `scheduler.py` — minimal Poisson slot planner для поддержания queue
  - `recovery.py` — reset_stale_tasks (running 5+ min без heartbeat → pending)
  - `working_hours.py` — per-(account × campaign) check с tz_offset
  - `exceptions.py` — CaptchaDetected, AuthenticationError, etc.
- **`linkedin/management/commands/rundaemon.py`** — Django entrypoint,
  `manage.py rundaemon` → `portal_daemon.main_loop.run_forever()`.

### Upstream bits (наследие, *не дёргаются daemon'ом*)

- `linkedin/models.py` — upstream Campaign/SiteConfig/LinkedInProfile/Task.
  CLI-команды (`linkedin/cli/`) могут на них опираться. Mainline daemon —
  нет.
- `crm/`, `chat/` — upstream Django apps (Lead, Deal, ChatMessage).
- `linkedin/agents/`, `linkedin/ml/`, `linkedin/db/summaries.py` — реальная
  LLM-qualification, GPR scoring, mem0 facts. Будем дёргать постепенно из
  `portal_daemon/handlers.py` по мере замены stub'ов.
- `linkedin/api/` — Voyager client. Будем использовать как есть.
- `linkedin/browser/` — auth flow, page-state machine.

## Status (10.06.2026)

✅ **Готово:**
- Schema migration (Portal Supabase)
- Portal API surface (start/stop/leads/captcha-resume)
- li2 Django app с моделями
- portal_daemon scaffolding: main_loop, AccountWorker, browser_session,
  executor, scheduler, recovery, working_hours, exceptions
- Dockerfile + docker-compose.prod.yml + ресурсы
- VNC stack (xvfb + x11vnc + noVNC через upstream Dockerfile)

⏳ **TODO (отдельный spec):**
- Реальные handler'ы (`portal_daemon/handlers.py`): связь с
  `linkedin/api/voyager`, `linkedin/agents/qualify_lead`,
  `linkedin/agents/follow_up_agent`. Сейчас stub'ы.
- nginx config для `/openoutreach-vnc/` с basic-auth
- Telegram-alert на `status='disconnected'`/`needs_captcha`
- Integration tests с testcontainers Postgres
- Реальный smoke test на dogfood-аккаунте

## Connecting to local dev

```bash
# 1. Запустить локальный Portal Supabase (если нужен реальный Postgres)
cd ../../deploy/main-db && docker compose up -d

# 2. Применить миграцию li2_*
cd ../../app && DATABASE_URL=postgresql://... npm run db:migrate

# 3. Поставить deps OpenOutreach'a
cd ../services/openoutreach && python -m venv .venv && \
    .venv/bin/pip install -r requirements/local.txt && \
    .venv/bin/playwright install chromium

# 4. Запустить daemon
DATABASE_URL=postgresql://... .venv/bin/python manage.py rundaemon
```
