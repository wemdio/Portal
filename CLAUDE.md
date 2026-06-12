# Portal repo — AI agent entrypoint

Этот файл подгружается Claude Code автоматически в начале каждой сессии.

## Что это за репозиторий

Portal — внутренний инструмент студии: Next.js app + воркеры на prod, self-hosted Supabase на DB-сервере, интеграция с Instantly для cold outreach. Инфраструктура описана в [`.env.servers`](./.env.servers) (НЕ коммитить).

- Прод: `139.60.162.12` (Next.js, workers, instantly-sync-bot, qualifier и т.д.)
- БД-сервер: `144.31.54.166` (main-postgres + два instantly-postgres + наш analytics-датасет `instantly_dataset` на том же контейнере)

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

## Что НЕ делать

- Не коммитить `.env*` файлы — там креды.
- Не дёргать Instantly /emails API больше 10 RPM пока `portal-worker-instantly-leads` контейнер запущен на prod — общий workspace rate limit, [инцидент 22 мая в `wiki/log.md`](./wiki/log.md).
- Не модифицировать `query_log` строки post-hoc для подкрутки метрик loop'a. Loop работает только если данные честные.
