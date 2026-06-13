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
  - `handlers.py` — реальные действия:
    - `handle_connect`: login → discover seed URLs → create Lead+Deal →
      send_invite → flip Deal state
    - `handle_check_pending`: scrape sent-invitations page → flip
      accepted Deals на `connected`
    - `handle_follow_up`: LLM-generated short DM → send → record ChatMessage
  - `li_actions.py` — Playwright primitives (login, discover, invite,
    message, list-pending) с fallback'ами на A/B варианты UI
  - `llm.py` — thin OpenRouter httpx-клиент, render_prompt помощник
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
- portal_daemon: main_loop + AccountWorker + browser_session + executor +
  scheduler (с PortalSettings limits) + recovery + working_hours + exceptions
- **Реальные handler'ы**: login flow, discover seed URLs, send_invite
  (Connect button с fallbacks), check_pending (sent-invitations scrape),
  follow_up (LLM via OpenRouter)
- Dockerfile + docker-compose.prod.yml + ресурсы
- VNC stack (xvfb + x11vnc + noVNC) внутри контейнера на порту 6080
- CI/CD: semaphore.yml билдит portal-openoutreach, scheduled-deploy.yml
  рестартит сервис

⏳ **TODO (после deploy + smoke на dogfood-аккаунте):**
- **nginx-proxy на хосте** для `/openoutreach-vnc/` → 127.0.0.1:6080 с
  basic-auth (см. секцию "VNC access" ниже)
- **PortalSettings**: пользователь должен зайти в UI и заполнить email/
  password/proxy_url + поставить `legal_accepted=true`
- Telegram-alert на `status='disconnected'`/`needs_captcha`
- Integration tests с testcontainers Postgres
- Полировка LinkedIn-селекторов после первого реального прогона (UI
  меняется, fallback цепочки нужно подстраивать по факту)

## Fixes 2026-06-12 (блокеры запуска)

Аудит 12.06 нашёл 4 блокера; 3 закрыты и проверены (pytest + jest), 1 частично:

- ✅ **#1 working_hours**: колонка БД `text[]`, а модель была `JSONField` →
  TypeError на чтении ЛЮБОЙ кампании (демон не исполнял ни одной задачи).
  Фикс: `li2/models.py` → `ArrayField(TextField)`, без DDL на проде.
- ✅ **#3 рендер промптов**: Portal слал Jinja2-шаблон `{{ var }}`, демон рендерил
  наивным `{var}` → плейсхолдеры текли в LLM. Фикс: `llm.render_prompt` → Jinja2
  (sandboxed, missing→''); Portal-дефолт follow_up переписан с action-протокола
  (который демон не парсит) на плоский DM; `promptVarValidation` синхронизирован.
- ✅ **#4 proxy_url**: битый прод-формат `socks5://ip:port:user:pass` уходил в
  Playwright как есть. Фикс: `browser_session.parse_proxy_url` + `ProxyConfigError`
  (socks5+auth Chromium не умеет → явный фейл, не тихий запуск с реального IP).
  ⚠️ Прод-прокси socks5+auth работать НЕ будет — нужен HTTP residential-прокси.
- 🟡 **#2 CAPTCHA/VNC**: сделан флаг `LI2_BROWSER_HEADLESS` + публикация порта 6080.
  Keep-alive пауза на checkpoint + nginx — НЕ сделаны, см. `docs/captcha-vnc-plan.md`
  (делать на dogfood с живым браузером).
- ✅ **stealth** (снижает частоту checkpoint): `playwright-stealth` подключён в
  `browser_session.py` (`_STEALTH.apply_stealth_async(ctx)`). Проверено:
  `navigator.webdriver` headless=true→false. Пакет уже был в base.txt, теперь применяется.

## Backend-фиксы 2026-06-12 (контрол-баги, без живого LinkedIn, юнит-тесты)

- ✅ **Stop отменяет задачи**: stop/route.ts шлёт `li2_tasks status='cancelled'` для
  pending-задач кампании; executor.py дополнительно НЕ выполняет задачу, если
  `campaign.status != 'running'` (отменяет её) — двойная страховка.
- ✅ **Weekly-лимит инвайтов**: scheduler учитывает connect-задачи за 7д против
  `connect_weekly_limit`; **жёсткий дневной лимит** — учёт созданных за 24ч
  (быстрый дренаж очереди больше не даёт второй батч в день). Чистая логика в
  `_slots_to_create` (10 юнит-тестов).
- ✅ **runtime_status/stats кампании**: демон (`scheduler._refresh_campaign_runtime`)
  каждую итерацию пишет `li2_campaigns.runtime_status='running'` + stats
  (leads/invited/connected из Deal-состояний) — карточка в UI больше не висит
  «queued_for_openoutreach».
- ✅ **follow-up не долбит вслепую**: `_connected_needing_followup` шлёт РОВНО ОДИН
  opener на connected-лида (было — повтор каждые 3 дня бесконечно). Многошаговый
  follow-up вернётся вместе с чтением входящих.

## Операторский UX 2026-06-12 (статус аккаунта в UI)

- ✅ GET `/api/tools/li-outreach-v2/accounts` — отдаёт li2_accounts (раньше GET-ручки
  не было, статусы были невидимы). UI (page.tsx): чип статуса аккаунта в хедере +
  баннер на needs_captcha/disconnected с кнопкой «Возобновить» (POST resume-from-captcha)
  + поллинг статуса каждые 15с. Теперь оператор видит, что аккаунт встал, и резюмит
  из UI (раньше — только curl). Проверено: tsc --noEmit чисто по всему app.

## Чтение входящих + conversation-loop 2026-06-12 (НАПИСАНО, не проверено на живом LinkedIn)

`handle_follow_up` переписан в полноценный диалоговый цикл (без нового task type —
вложено в follow_up, без миграции):
- `li_actions.read_thread(ctx, profile_url, public_identifier)` — открывает оверлей
  переписки (та же кнопка Message, что send_message), скрейпит сообщения одним
  page.evaluate, направление по ссылке отправителя vs public_identifier лида.
  ⚠️ Селекторы (.msg-s-message-group и т.д.) — текущего UI, нужна донастройка на
  живом аккаунте.
- handler: round-robin connected-Deal (по updated_at) → read_thread → пишет новые
  inbound в li2_messages с дедупом по external_id (urn или стабильный sha1, НЕ
  hash()) → решает: opener (переписки нет) / контекстный ответ (последняя реплика
  от лида) / wait (последнее слово за нами). Cap MAX_AUTO_MESSAGES_PER_LEAD=5 →
  дальше оператору. Outbound пишем только при отправке (скрейп — только inbound,
  чтобы не дублить).
- Промпт follow_up стал conversational: `{{ recent_messages }}` (тред Me/Lead) +
  режим opener/ответ. Синхронизировано: daemon _FOLLOWUP_SYSTEM_PROMPT,
  v2DefaultPrompts.ts, promptVarValidation (req var recent_messages добавлен).
- Юнит-тесты (pure): _format_recent_messages, _inbound_external_id. DOM-скрейп и
  DB-склейка — на dogfood.

## Дискавери + LLM-квалификация 2026-06-12 (НАПИСАНО, не проверено на живом LinkedIn)

Вложено в handle_connect (без нового task type/миграции), изолированно — включается
ТОЛЬКО когда qualified-пул пуст (seed'ы кончились), в try/except, рабочий seed-флоу не
трогает; CAPTCHA/Auth пробрасываются.
- `li_actions.search_people(query)` — DOM-скрейп /search/results/people (⚠️ селекторы —
  донастройка на живом).
- `_discover_batch`: LLM-генерация поисковых запросов (промпт `search_keywords`, был
  мёртвым → живой; кэш в qualifiers[0]['_discovery'] + cursor) → People-search по
  следующему keyword → discover_profile → LLM-квалификация (промпт `qualify_lead`, тоже
  был мёртвым → живой; YES/NO+причина) → qualified Lead+Deal либо disqualified-маркер.
- Pure-тесты: _parse_keywords, _parse_qualify_verdict.

Ещё открыто (требует живого LinkedIn): **Deal→completed по outcome** (диалог ведётся, но
авто-закрытия сделки по исходу «не интересно» нет); **ML** (GPR/BALD из upstream
linkedin/ml — опционально, LLM-квалификации для MVP хватает); **UI**: поле ответа
оператора в переписке (тред read-only); **Telegram-алерты** (плумбинг демон→Portal API→TG,
инфра app/src/lib/instantly/leadTelegramAlerts.ts); **CAPTCHA keep-alive**
(docs/captcha-vnc-plan.md — делать на живом checkpoint).

## Dogfood / устойчивость к редеплою 2026-06-12

- **Весь state в Postgres (144), контейнер stateless** → инструмент переживает
  редеплои: после пересоздания демон перечитывает li2_accounts + storage_state из
  li2_browser_sessions и продолжает. Засеянная сессия живёт в БД, переживает ночной
  деплой.
- **Graceful-stop в деплое**: `.semaphore/scheduled-deploy.yml` перед force-rm делает
  `docker stop -t 120 portal-openoutreach` — SIGTERM даёт демону доделать in-flight
  task и сохранить storage_state (раньше SIGKILL мимо grace терял свежие cookies).
- **Пред-засев сессии (обход checkpoint первого входа)**: `manage.py seed_li2_session
  --user-id <uuid>` — ручной логин в headed-браузере ЧЕРЕЗ прокси демона → пишет
  storage_state в li2_browser_sessions. Демон стартует залогиненным с того же IP.
  Запускать локально (реальный дисплей), DATABASE_URL → прод-Supabase. Аккаунт
  (li2_accounts) должен уже существовать — создаётся при первом старте кампании в UI.

## VNC access (для прохождения CAPTCHA)

Контейнер expose'ит noVNC на 6080 внутри сети `portal-network`. Чтобы
оператор мог открыть VNC из браузера, нужно добавить nginx-проксю на
хосте `139.60.162.12`. Снippет в `/etc/nginx/sites-available/polza-portal`:

```nginx
# Inside the polza-portal.ru server block:
location /openoutreach-vnc/ {
    # basic-auth: створяй .htpasswd через htpasswd -cb /etc/nginx/.openoutreach-vnc <user> <pw>
    auth_basic "OpenOutreach VNC";
    auth_basic_user_file /etc/nginx/.openoutreach-vnc;

    # noVNC внутри контейнера сидит на :6080. portal-openoutreach в
    # portal-network → доступен по docker bridge IP, но проще
    # publish:127.0.0.1:6080:6080 в docker-compose.prod.yml (добавь
    # `ports: ['127.0.0.1:6080:6080']` к openoutreach сервису).
    proxy_pass http://127.0.0.1:6080/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 86400;
}
```

`sudo systemctl reload nginx`. Затем `https://polza-portal.ru/openoutreach-vnc/`
→ basic-auth → noVNC web client с remote-desktop'ом контейнера.

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
