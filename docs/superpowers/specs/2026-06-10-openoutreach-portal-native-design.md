# OpenOutreach Portal-native интеграция — design spec

**Дата:** 2026-06-10
**Автор:** Дмитрий Кулага (через brainstorm с AI)
**Статус:** draft → review
**Связанное:** LinkedIn Outreach 2.0, `li2_*` schema, [упавший «queued»-only сценарий 10.06.2026](../../../wiki/log.md)

## Проблема

10 июня 2026 в 09:28 в `li-outreach-v2` была поставлена кампания «Polza Agency»; через 23 минуты в журнале висел один-единственный лог «OpenOutreach start job queued». Расследование показало: **job-pipeline полу-подключён** — в БД `li2_jobs` пишет Portal API, но **нет ни одного процесса**, который бы из этой очереди читал. Сам OpenOutreach лежит вендорированным в `.tmp/OpenOutreach/` (не закоммичено), не задеплоен на проде, и его архитектура (Django+SQLite, single-tenant) **не совместима** с мультитенантной моделью Portal.

Текущая работа Portal'a по фиче (commits `1550cc2e` → `6c88588c`, 21 мая — 9 июня) построила корректный UI и API-каркас (`li2_settings`, `li2_campaigns`, `li2_leads`, `li2_messages`, `li2_logs`, `li2_jobs`, прошитую в payload jinja2-конфигурацию), но интеграция с самим автоматизатором осталась за кадром.

## Цель

Запустить v2 LinkedIn Outreach (OpenOutreach-based) end-to-end на проде в multi-tenant режиме до 5-20 одновременно активных LinkedIn-аккаунтов. Сохранить Portal как единственный UI, Supabase как единственный source of truth.

## Не-цели

- SaaS-масштаб 20+ аккаунтов — отложено до второй итерации
- Миграция существующих v1 (`li_*`) кампаний в v2 — v1-воркер `worker-li-outreach` продолжает работать параллельно
- Полная совместимость с upstream OpenOutreach — мы форкаем (см. UPSTREAM.md в форке)

## Архитектурное решение

Вариант **B** из brainstorm'a: форк OpenOutreach + Postgres backend.

```
┌─────────────── Portal Supabase (Postgres) ────────────────────┐
│ li2_accounts        ← daemon polls на status='running'        │
│ li2_campaigns/leads ← общая БД UI и daemon'a                  │
│ li2_deals/tasks     ← новые: state-machine + planner queue    │
│ li2_browser_sessions← cookies / storage_state                 │
│ li2_settings        ← Portal-side prefs (промпты, лимиты)     │
│ li2_jobs            ← DROPPED, заменён state-flip             │
└────────────────────────┬─────────────────────┬─────────────────┘
                         │                     │
            ┌────────────▼────────┐  ┌─────────▼──────────────────┐
            │ Portal (Next.js)    │  │ portal-openoutreach        │
            │ ─ /tools/li-...v2   │  │ ─ Django ORM @ Postgres    │
            │ ─ POST /start       │  │ ─ daemon.py: main loop +   │
            │   flips status      │  │   N AccountWorker (async)  │
            │ ─ POST /stop        │  │ ─ ephemeral Chromium per   │
            │ ─ GET /leads/.../   │  │   task, cap=3 concurrent   │
            │   /logs             │  │ ─ VNC :6080 (internal)     │
            └─────────────────────┘  └────────────────────────────┘
```

**Ключевые свойства:**

- **Единый Postgres**: OpenOutreach Django ORM подключается к Portal Supabase через `DATABASE_URL=$SUPABASE_DB_URL`. Никакого SQLite, никакой кросс-БД синхронизации.
- **Очередь `li2_jobs` дропнута.** Контракт Portal↔daemon — одно поле `li2_accounts.status` (`stopped`/`running`/`needs_captcha`/`disconnected`). Daemon реагирует поллингом каждые 5 сек.
- **Один процесс, N async-сессий**: daemon держит `dict[account_id → AccountWorker]`. Cross-account параллельность (cap = 3 одновременных Chromium'а), within-account — strictly serial.
- **Ephemeral browsers**: Chromium открывается per task на 30-180 сек, закрывается. Cookies/storage_state в `li2_browser_sessions` (BYTEA + JSONB). Контейнер stateless.
- **CAPTCHA**: Playwright детектит `/checkpoint/`, daemon flip'ает `status='needs_captcha'`, оператор открывает VNC :6080 (через `portal-rdp-ws` sidecar или nginx-proxied), проходит вручную, шлёт обратно `status='running'`.

## Модель данных

**(a) Существующие `li2_*` — оставляем имена, аугментируем колонки:**

| Таблица | Добавляется | Назначение |
|---|---|---|
| `li2_settings` | — | без изменений |
| `li2_campaigns` | `model_blob bytea`, `qualifiers jsonb` | GPR-модель кампании, per-campaign LLM-qualifiers |
| `li2_leads` | `urn text`, `embedding bytea`, `disqualified bool DEFAULT false`, `meta jsonb DEFAULT '{}'` | Voyager URN, 384-dim FastEmbed bytes, permanent-exclude, raw payload |
| `li2_messages` | `external_id text` (unique-on-conflict) | Dedup от webhook/scrape повторов |
| `li2_logs` | — | без изменений |

**(b) Новые `li2_*` — внутреннее состояние OpenOutreach:**

| Таблица | Назначение |
|---|---|
| `li2_accounts` | Один LinkedIn-аккаунт на portal-юзера. PK `(user_id)`. Поля: `status`, `runtime_status`, `last_heartbeat_at`, `last_error`, `account_id uuid`. **Эту таблицу daemon крутит в основном цикле.** |
| `li2_deals` | Per-(campaign × lead) state machine row. State: `QUALIFIED → READY_TO_CONNECT → PENDING → CONNECTED → COMPLETED/FAILED`. + `outcome`, `profile_summary jsonb`, `chat_summary jsonb`, `next_check_pending_at`. |
| `li2_tasks` | OpenOutreach planner queue (Poisson-распределённые task slots в 24h окне). Поля: `task_id`, `account_id`, `campaign_id`, `type` (`connect`/`check_pending`/`follow_up`), `status`, `scheduled_at`, `payload jsonb`. |
| `li2_browser_sessions` | Per-account cookies + storage_state. Поля: `user_id`, `account_id`, `storage_state jsonb`, `cookies bytea`, `updated_at`. |

**(c) Дропаем:** `li2_jobs` (заменено state-flip-ом).

**RLS:** на всех новых таблицах — `auth.uid() = user_id`. Service-role grants — для daemon (он коннектится service_role-ключом).

**Lead vs Deal**: текущая `li2_leads` смешивает обе сущности. После миграции `li2_leads` хранит per-lead-per-user данные (URN, embedding, базовый профиль), а per-(campaign, lead) состояние (`state`, `outcome`, `qualification_*`, `chat_summary`) уезжает в `li2_deals`. Migration script переливает существующие данные — реальных продакшен-кампаний на v2 ещё нет, миграция фактически no-op по данным.

## Daemon

**Структура:**

```
MainLoop (asyncio):
  loop forever:
    accounts_running = SELECT * FROM li2_accounts WHERE status='running'
    for new in (running - tracked):  spawn AccountWorker
    for gone in (tracked - running): stop AccountWorker
    touch /tmp/li2-daemon-heartbeat
    reset_stale_tasks()  # status='running' AND no heartbeat 5+ min → 'pending'
    await asyncio.sleep(POLL_INTERVAL_SEC)

AccountWorker (one asyncio.Task per running account):
  loop while not stopping:
    reconcile()                          # planner добивает li2_tasks
    task = next_due_task()               # учитывает campaign.working_hours + tz_offset
    if not task:
      await asyncio.sleep(60); continue
    async with semaphore(MAX_CONCURRENT_BROWSERS):   # global cap
      async with browser_session() as ctx:           # ephemeral Chromium
        await execute(task, ctx)                     # invite/message/qualify
    update li2_accounts.last_heartbeat_at = now()
  on CaptchaDetected:        status='needs_captcha', log warning, exit run
  on AuthenticationError:    status='disconnected',  log error,   exit run
```

**Concurrency:**

| Свойство | Выбор | Обоснование |
|---|---|---|
| Cross-account | Параллельно, cap=3 одновременных browsers | LinkedIn не видит другие аккаунты, безопасно. Cap — чтобы 20 случайно не зажали peak RAM. |
| Within-account | Strictly serial | Та же причина, что у v1 (`liOutreach.ts:39-53`): два одновременных burst'а = trip anti-bot. |
| Browser lifecycle | Ephemeral (open per task, close after) | Cold start ~5-8s vs task duration 30-180s = ~5% overhead. RAM peak ограничивается cap'ом, а не активным числом аккаунтов. |
| Cookies | Postgres BYTEA + JSONB | Stateless контейнер: killed-restored-resumed без потери логина. |
| Heartbeat | Per-account `li2_accounts.last_heartbeat_at` + per-daemon `/tmp/li2-daemon-heartbeat` каждые 30s | Daemon-side — Docker healthcheck (autoheal перезапускает). Per-account — UI. |
| Working hours | AccountWorker проверяет ДО запуска task'a; outside → `task.scheduled_at = next_window_open()` | Upstream OpenOutreach делает это глобально; мы переносим на per-(account × campaign). |
| LLM keys | `OPENROUTER_LI_OUTREACH_API_KEY` env, общий | Согласуется с commit `cbf88b46` (BYOK выпилен). |
| Proxy | Per-account `li2_settings.proxy_url`, Playwright launches с ним | LinkedIn ban-detection через ASN — без residential proxy не выйдет. |

**Что НЕ переписываем из upstream'а** (сохраняется через форк):

- ML pipeline (GPR + BALD active learning), `model_blob` в БД
- LLM qualification prompts (наши кастомные из `li2_settings.prompt_*` injection)
- Voyager API client (`linkedin_cli` package)
- State machine `QUALIFIED → ... → COMPLETED/FAILED`
- Chat/profile summary (mem0-style fact reconciliation)
- Poisson slot planner

## Portal API изменения

| Endpoint | Изменение |
|---|---|
| `POST /start` | `update li2_accounts set status='running' where user_id=…`, лог `'Campaign activated'`. Убрать `li2_jobs` insert. |
| `POST /stop` | `update li2_accounts set status='stopped' where user_id=…`, лог `'Campaign stop requested'`. |
| `GET /leads` | Join с `li2_deals` для per-campaign state, выдавать сводный объект. |
| `GET /logs` | Без изменений (daemon пишет в `li2_logs`). |
| `GET /messages` | Без изменений. |
| **NEW** `POST /accounts/[id]/resume-from-captcha` | После прохождения CAPTCHA в VNC — флип `status='needs_captcha'`→`'running'`. |

## Deployment

**Dockerfile** (`services/openoutreach/Dockerfile`):
- Base: `mcr.microsoft.com/playwright/python:v1.42-jammy`
- + `xvfb`, `x11vnc`, `fluxbox`, `novnc`, `websockify`, `supervisor`
- Pre-pull FastEmbed (~300 MB модель в RAM warm) на build time
- Entrypoint: supervisord (Xvfb + x11vnc + novnc + `python manage.py rundaemon`)
- HEALTHCHECK: `/tmp/li2-daemon-heartbeat` < 120s

**docker-compose.prod.yml**:

```yaml
openoutreach:
  image: ${DOCKER_USERNAME}/portal-openoutreach:prod
  container_name: portal-openoutreach
  env_file: [.env]
  environment:
    - DJANGO_SETTINGS_MODULE=django_settings
    - DATABASE_URL=${SUPABASE_DB_URL}
    - OPENROUTER_LI_OUTREACH_API_KEY=${OPENROUTER_LI_OUTREACH_API_KEY}
    - LI2_DAEMON_POLL_INTERVAL_SEC=${LI2_DAEMON_POLL_INTERVAL_SEC:-5}
    - LI2_MAX_CONCURRENT_BROWSERS=${LI2_MAX_CONCURRENT_BROWSERS:-3}
    - LI2_BROWSER_HEADLESS=true
    - ENABLE_VNC=true
  labels: [autoheal=true]
  healthcheck:
    test: ["CMD-SHELL", "test -f /tmp/li2-daemon-heartbeat && test $$(( $$(date +%s) - $$(cat /tmp/li2-daemon-heartbeat | cut -c1-10) )) -lt 300 || exit 1"]
    interval: 60s
    timeout: 5s
    retries: 3
    start_period: 120s
  stop_grace_period: 5m
  deploy:
    resources:
      limits:
        memory: 2560M
        cpus: '1.5'
  restart: unless-stopped
  networks: [portal-network]
```

**Где размещаем**: текущий прод (`139.60.162.12`), после освобождения ресурсов через удаление `worker-enrich-10` из compose (2 GB / 1 CPU освобождается; enrich-pool по комментарию автора overcapped — 10% throughput-loss не критичен).

**VNC доступ**: `:6080` в `portal-network`, не публиш'им наружу. Внешний доступ — через nginx с basic-auth на `/openoutreach-vnc/`, конфиг добавляется в deploy. Альтернатива — туннель через существующий `portal-rdp-ws` sidecar (он умеет Guacamole для VNC, переиспользовать его connector).

## Rollout-план (high-level)

1. Supabase-миграция (schema)
2. Portal API изменения (синхронно с миграцией, atomic deploy через нашу обычную CI'ю)
3. Форк OpenOutreach в `services/openoutreach/` (главный объём работы — ~1-2 недели)
4. Dockerfile + supervisord
5. Edit `docker-compose.prod.yml`: убрать `worker-enrich-10`, добавить `openoutreach`
6. Push image, pull on prod, start
7. Smoke test на моём LinkedIn-аккаунте (VNC-логин + одна кампания Polza Agency)
8. Production hardening (Telegram-alerts на `disconnected`/`needs_captcha`, health-check, `services/openoutreach/CLAUDE.md`)

## Тестирование

- **Python unit** (pytest in `services/openoutreach/tests/`) — upstream-тесты сохраняем, добавляем для multi-account dispatch + Postgres backend
- **Integration** (testcontainers Postgres) — daemon в CI поднимается, не падает 30 сек
- **E2E smoke** (Next.js test) — POST `/start` → polling `li2_accounts.last_heartbeat_at` обновляется в 60 сек
- **Ручной** — VNC observation первой кампании на dogfood-аккаунте

## Открытые вопросы (для implementation plan'а)

1. Насколько глубоко `SiteConfig`-singleton прошит через upstream. Если глубже ожидаемого — рефакторинг может разрастись; решаем по факту
2. Первый логин (email+password → cookies) у нового аккаунта может уткнуться в CAPTCHA — VNC должен быть готов и доступен до первой попытки
3. Django Admin — выключаем (`urls.py` без admin route)
4. Дальнейшая стратегия upstream-мержей — каждый upstream-релиз требует ручной discipline merge через `services/openoutreach/UPSTREAM.md`

## Метрики успеха

- ✅ После «Start» в UI: `li2_accounts.last_heartbeat_at` обновляется минимум раз в минуту
- ✅ Первый invite уходит в пределах working_hours после старта
- ✅ `li2_logs` наполняется per-step событиями (sent invite, qualified lead, etc.)
- ✅ CAPTCHA flow работает end-to-end (VNC + resume)
- ✅ Стоп кампании корректно дотачивает текущий task и не оставляет zombie Chromium
- ✅ Перезапуск контейнера не теряет логин (cookies в Postgres)
