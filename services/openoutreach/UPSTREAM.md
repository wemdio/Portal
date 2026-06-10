# OpenOutreach Upstream Tracker

**Upstream:** OpenOutreach — self-hosted LinkedIn automation for B2B lead generation
(см. `README.md` в этой папке для деталей upstream'a)

**Forked from SHA:** `1bdc643f5e33c739068ce222477fb1e7170b18de`
**Forked on:** 2026-06-10
**Forked by:** Portal team

## Зачем форк

Portal'у нужна интеграция с OpenOutreach как multi-tenant сервисом, читающим
свой state из Portal'овской Supabase (а не из локального SQLite, как делает
upstream). Upstream при этом архитектурно single-tenant: один `SiteConfig`-
singleton, одна LinkedIn-учётка на инстанс. См. spec
[docs/superpowers/specs/2026-06-10-openoutreach-portal-native-design.md](../../docs/superpowers/specs/2026-06-10-openoutreach-portal-native-design.md).

## Fork divergence

Точки расхождения с upstream'ом:

| Что | Upstream | Наш fork |
|---|---|---|
| DB backend | SQLite (`data/db.sqlite3`) | Postgres (Portal Supabase, через `DATABASE_URL`) |
| Tenancy | Single (`SiteConfig` singleton) | Multi (`Account` model, ключ `user_id` из Portal'a) |
| Linkedin creds | `SiteConfig.linkedin_email/password` | `PortalSettings.objects.get(user_id=…)` (читаем из `li2_settings`) |
| LLM creds | `SiteConfig.llm_api_key/api_base/model` | Env-var `OPENROUTER_LI_OUTREACH_API_KEY`, общий на всех |
| Daemon | `manage.py rundaemon` — один global `session` (browser) | Async MainLoop поллит `li2_accounts` и dispatch'ит N AccountWorker'ов, у каждого свой ephemeral Chromium |
| Cookies storage | На диске (`data/cookies/<email>.json`) | В Postgres `li2_browser_sessions` (BYTEA + JSONB) |
| Browser lifecycle | Persistent (один на весь runtime) | Ephemeral (open per task, close after) |
| Admin UI | Django Admin на `/admin/` | Выключен (Portal UI достаточен) |
| Model.Meta.db_table | Default (auto-generated) | Явный `li2_*` (соответствуют Portal'овской миграции 20260610_0001) |
| Models.managed | True (Django миграции owns the schema) | False (schema owns supabase/migrations/, Django только читает) |

## Что мы НЕ трогаем (наследуется из upstream'a)

Эти куски OpenOutreach работают как есть, мы их не переписываем:

- **ML pipeline** (`linkedin/ml/`) — GPR + BALD active learning, model_blob лежит на `li2_campaigns.model_blob`
- **LLM qualification prompts** (`linkedin/agents/`) — наши кастомные промпты из `li2_settings.prompt_*` injection-ятся через тот же jinja2-механизм
- **Voyager API client** (`linkedin/api/`, упстрим-пакет `linkedin_cli`) — внешняя зависимость
- **State machine** `QUALIFIED → READY_TO_CONNECT → PENDING → CONNECTED → COMPLETED/FAILED`
- **Chat/profile summary** (`linkedin/db/summaries.py`) — mem0-style fact reconciliation
- **Poisson slot planner** (`linkedin/tasks/scheduler.py`) — алгоритм расписания

## Re-syncing с upstream

Раз в квартал (или при критичном upstream-фиксе):

1. Клонировать upstream в `.tmp/openoutreach-upstream-<date>/`
2. `git log` upstream'a с момента нашего форка → собрать список cherry-pick'ов
3. `git diff .tmp/openoutreach-upstream-<date> services/openoutreach/` — посмотреть
   зоны нашего расхождения (см. таблицу выше) и обходить их при мерже
4. Cherry-pick по одному, тестировать `services/openoutreach/tests/`
5. Запустить локальный smoke (см. `services/openoutreach/CLAUDE.md`)
6. Обновить SHA в этом файле

**Зона повышенного внимания** — `linkedin/models.py`, `linkedin/daemon.py`,
`linkedin/onboarding.py`, `linkedin/conf.py`. Upstream может добавить новые
`SiteConfig.X`-поля — в нашем форке их место в `PortalSettings`/`Account`
(или в Portal'овский `li2_settings`, если нужно UI-ить).
