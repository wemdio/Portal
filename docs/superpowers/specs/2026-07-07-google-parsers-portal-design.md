# Google Maps + Google News парсеры на портале — дизайн

**Дата:** 2026-07-07
**Автор:** Дмитрий Кулага (по коду от Jacob Brown)
**Статус:** утверждён к реализации
**Первоисточник:** `G:\PycharmProjects\google-maps-news-parsers` (готовый standalone-инструмент)

## Цель

Портировать два готовых парсера (Google Maps + Google News) в портал как две новые вкладки на странице `/parsers`, с полной интеграцией в инфру портала — Supabase, воркеры, очередь, «Добавить в базу лидов». Убрать standalone-приложение.

## Мотивация

- Command студии сейчас гоняет платный Outscraper для Google News CSV. Свой парсер = экономия.
- Google Maps даёт качественный лид-сорс (email/LinkedIn на сайте компании) — раньше делали руками через Google Maps + ручной обход сайтов.
- Единый UX: у пользователя одно окно `/parsers`, а не два разных инструмента.

## Что видит пользователь

### Страница `/parsers` — добавляются две вкладки

Вкладки идут в общем ряду с HH.ru / ENG вакансии / Crunchbase / Yandex Maps / Yandex Direct / Crypto:

```
[HH.ru] [ENG вакансии] [Crunchbase] [EU/US] [HH-архив]
[Поиск] [Yandex Maps] [Yandex Direct] [Crypto]
[Google Maps 🆕] [Google News 🆕]
```

### Вкладка Google Maps

Клон дизайна `YandexMapsParserView.tsx`:

- Textarea со списком URL Google Maps или поисковых запросов (по строке)
- Настройки: лимит на URL, язык (`ru` default), регион (`RU` default), задержки мин/макс (мс), чекбокс «искать email/LinkedIn на сайте», прокси per-job (textarea)
- Кнопки: **Запустить / Пауза / Стоп / Скачать CSV / Скачать JSON / Добавить в /tools/databases**
- Таблица результатов: Компания · Адрес · Телефон · Сайт · LinkedIn · Email · Рейтинг · Статус
- Список прошлых джобов слева (как у Yandex Maps): выбор → показывает результаты
- Индикатор очереди: «в очереди перед вами: N»

### Вкладка Google News

- Textarea с ключевыми запросами (по строке)
- Настройки: лимит страниц (1–10), страна, язык, диапазон дат (`any` / `hour` / `day` / `week` / `month` / `year`), задержки мин/макс, прокси per-job
- Кнопки: **Запустить / Пауза / Стоп / Скачать CSV / Скачать JSON** (без «Добавить в базу» — это не лиды)
- Таблица результатов: Query · Position · Title · Body · Posted · Source · Link
- CSV — в формате Outscraper (для подмены платного API)

Всё в стиле портала — Tailwind, единые компоненты `JobStatus`, `JobsList`, `RegionPicker`, `ClientTariffUsageInline` (последний скрыт для не-клиентского режима).

## Архитектура

Ровно паттерн Яндекс.Карт — три кубика:

```
[Портал (Next.js)] ──создаёт job──► [Supabase таблицы на 144.31.54.166]
                                          │
                                          ▼
                        [worker-googleparsers]  ──HTTP──►  [googleparsers service (Playwright)]
                                          │                     (порт 8001 внутри docker network)
                                          ▼
                                     [пишет результаты в Supabase]
                                          │
                                          ▼
                                     [UI polls каждые 1800 мс, обновляет прогресс]
```

### Что откуда берём

**Из `google-maps-news-parsers` (Jacob):**
- `server/parser/googleMapsParser.ts` + `server/parser/googleNewsParser.ts` — Playwright-логика (без изменений)
- `shared/googleMaps.ts` + `shared/googleNews.ts` + `shared/normalize.ts` + `shared/types.ts` — типы и утилиты (без изменений)
- `shared/export.ts` — CSV-сериализация (без изменений; Outscraper-формат для News)
- `server/index.ts` — Express-роуты (адаптируются: убираем file-storage, добавляем очередь через Supabase)

**Не берём:**
- `src/App.tsx` + `src/api.ts` — React-фронт, перерисовываем под Tailwind портала
- `server/jobStore.ts` + `server/newsJobStore.ts` — file-based хранилище (`data/*.json`), заменяется на Supabase
- `dist/`, `index.html`, `vite.config.ts` — свой Next.js вместо Vite

## Модель данных (Supabase, self-hosted на `144.31.54.166`)

Миграция: `supabase/migrations/2026-07-07_create_google_parsers_tables.sql`

### `google_maps_jobs`

```sql
create table public.google_maps_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in (
    'queued','running','paused','stopped','completed','failed',
    'captcha','blocked','timeout','login_required'
  )),
  config jsonb not null default '{}'::jsonb,      -- inputLines, limitPerQuery, language, region, delays, enrichContacts
  message text,                                   -- last status message from parser
  total_targets integer default 0,
  processed_targets integer default 0,
  total_results integer default 0,
  proxy_enabled boolean not null default false,
  proxy_encrypted text,                           -- encrypted list of proxies
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text
);
```

### `google_maps_places`

```sql
create table public.google_maps_places (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.google_maps_jobs(id) on delete cascade,
  query text,
  name text,
  category text,
  address text,
  phone text,
  website text,
  emails text[],                                  -- from enrichContacts pass
  linkedin_url text,
  google_maps_url text,
  place_id text,
  rating text,
  reviews_count integer,
  latitude double precision,
  longitude double precision,
  dedupe_key text,                                -- placeId | domain | name+address
  status text,                                    -- ok, no_website, timeout, etc.
  created_at timestamptz not null default now()
);

create unique index idx_google_maps_places_job_dedupe
  on public.google_maps_places(job_id, dedupe_key);
create index idx_google_maps_places_job_id
  on public.google_maps_places(job_id);
```

### `google_news_jobs`

```sql
create table public.google_news_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in (
    'queued','running','paused','stopped','completed','failed',
    'captcha','blocked','timeout','login_required'
  )),
  config jsonb not null default '{}'::jsonb,      -- queries, pagesLimit, country, language, dateRange, delays
  message text,
  total_targets integer default 0,
  processed_targets integer default 0,
  total_results integer default 0,
  proxy_enabled boolean not null default false,
  proxy_encrypted text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text
);
```

### `google_news_results`

```sql
create table public.google_news_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.google_news_jobs(id) on delete cascade,
  query text not null,
  position integer,
  title text,
  body text,
  posted text,                                    -- raw string from Google, no normalisation
  source text,
  link text,
  created_at timestamptz not null default now()
);

create index idx_google_news_results_job_id
  on public.google_news_results(job_id);
```

Дедуп в News-таблице **не делаем** намеренно — оригинал сохраняет одну ссылку из двух запросов как две строки, чтобы CSV совпадал с форматом Outscraper.

### Меппинг Maps → /tools/databases

Кнопка «Добавить в базу лидов» на Maps-вкладке использует существующие `buildDatabasesImportUrl` + `writePendingDbImport` (как у Yandex Maps). Меппинг полей:

| `google_maps_places` поле | Поле в базе лидов |
|---|---|
| `name`                | `company`   |
| `phone`               | `phone`     |
| `website`             | `website`   |
| `emails[0]`           | `email`     |
| `linkedin_url`        | `linkedin`  |
| `address`             | `address`   |
| `category`            | `industry`  |

Пустые/нулевые поля пропускаются. Дубли в базе лидов детектит `/tools/databases`, не парсер.

### Pause / Resume / Stop / Captcha

Ровно поведение оригинала (`isJobActive` = `queued | running | paused`, всё остальное — терминально):
- **Pause** — воркер завершает текущий target, ждёт сигнала resume. UI показывает «Пауза».
- **Resume** — воркер продолжает с `processed_targets + 1`. Разрешён только из статуса `paused`.
- **Stop** — воркер завершает текущий target, статус `stopped`, результаты сохраняются, resume недоступен.
- **Captcha / blocked / timeout / login_required** — job уходит в терминальный статус, `processed_targets` сохраняется. Пользователь создаёт новый job (при желании — с изменёнными прокси). Auto-retry — вне scope этого PR.

### RLS

Как у Yandex Maps: `select/insert/update/delete own` через `auth.uid() = user_id`. `service_role` (воркер) обходит RLS обычным образом.

## API-роуты (Next.js)

Ровно копия `yandexmaps/`:

```
POST   /api/parsers/googlemaps                 создать job
GET    /api/parsers/googlemaps                 список моих jobs
GET    /api/parsers/googlemaps/:id             один job + прогресс
POST   /api/parsers/googlemaps/:id/pause
POST   /api/parsers/googlemaps/:id/resume
POST   /api/parsers/googlemaps/:id/stop
GET    /api/parsers/googlemaps/:id/results     paginated (limit/offset), 5000 per page
GET    /api/parsers/googlemaps/:id/export.csv
GET    /api/parsers/googlemaps/:id/export.json
GET    /api/parsers/googlemaps/queue-status    сколько джобов в очереди сейчас

/api/parsers/googlenews/*                      симметрично, но с /results (пагинация нужна и там — до 100 строк на страницу × 10 запросов = 1000 строк per job)
```

Auth-guard стандартный — `authFetchJson` на клиенте, проверка `auth.uid()` через RLS в БД.

**Shape ответа `queue-status`:**

```ts
{
  activeJobId: string | null,    // текущий running job (мой ли — клиент решит сам)
  queuedCount: number,           // сколько джобов в статусе 'queued' впереди меня
  averageJobDurationSec: number  // средняя длительность completed за последние 24ч
}
```

## Воркер и Playwright-сервис

### `services/googleparsers/` (новый Docker-контейнер)

- Node 20 + TypeScript + Playwright + Chromium
- Express-сервер на порту 8001
- Роуты:
  - `POST /run/maps` — принимает `ScrapeSettings`, вебсокет-стримом отдаёт результаты, поддерживает pause/resume/stop
  - `POST /run/news` — то же для `NewsScrapeSettings`
- Код парсера — 1-в-1 из `google-maps-news-parsers/server/parser/` и `shared/`
- Dockerfile — базовый образ `mcr.microsoft.com/playwright:v1.49.1-noble`

### `worker-googleparsers` (новый Docker-контейнер)

- Node 20, тот же образ портала (`Dockerfile.worker`)
- Стратегия «one job at a time» (`GOOGLEPARSERS_CONCURRENCY=1` на старте):
  1. `SELECT ... FROM google_maps_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`
  2. `UPDATE ... SET status = 'running', started_at = now()`
  3. HTTP POST в `googleparsers` service, стримит результаты
  4. Батчами (по 20 строк) `INSERT` в `google_maps_places` / `google_news_results`
  5. При pause/stop-сигнале (проверка каждые 2 сек) — отправить команду в service, обновить статус
  6. При completion — `UPDATE ... SET status = 'completed', completed_at = now()`
  7. Тот же цикл для `google_news_jobs`
- Если джобов нет — `sleep(2s)` и снова poll

## Deploy — `docker-compose.prod.yml`

```yaml
googleparsers:
  image: ${DOCKER_USERNAME}/portal-googleparsers:prod
  container_name: portal-googleparsers
  restart: unless-stopped
  networks:
    - portal-net
  # порт 8001 внутри сети, наружу не выставляется

worker-googleparsers:
  image: ${DOCKER_USERNAME}/portal-worker:prod   # reuses Dockerfile.worker
  container_name: portal-worker-googleparsers
  restart: unless-stopped
  environment:
    - WORKER_KIND=googleparsers
    - GOOGLEPARSERS_SERVICE_URL=http://googleparsers:8001
    - GOOGLEPARSERS_CONCURRENCY=1
    - GOOGLEPARSERS_PROXY_ENCRYPTION_KEY=${GOOGLEPARSERS_PROXY_ENCRYPTION_KEY}
    - SUPABASE_URL=${SUPABASE_URL}
    - SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
  depends_on:
    - googleparsers
  networks:
    - portal-net

# app-service и worker-others тоже получают:
#   - GOOGLEPARSERS_SERVICE_URL=http://googleparsers:8001
#   - GOOGLEPARSERS_PROXY_ENCRYPTION_KEY=${GOOGLEPARSERS_PROXY_ENCRYPTION_KEY}
```

**`.env` на прод-сервере — одна новая переменная:**

```env
GOOGLEPARSERS_PROXY_ENCRYPTION_KEY=<32 hex bytes, generated once>
```

Генерация: `openssl rand -hex 32` на прод-сервере, добавить в `.env`, `docker compose up -d`.

**Ресурсы:** Playwright + Chromium ~500 МБ idle, до 1.5 ГБ на активный job. Yandex Maps уже крутится с тем же профилем — запас есть, но CONCURRENCY=1 сохраняем на старте.

## Что НЕ входит в первый PR

Явно откладывается, обсуждается отдельно:

- **Клиентский режим** — no `clientMode` flag, no client-tariff-limits, no client RLS policies. Портал раздаёт доступ только сотрудникам через `role in ('admin','sales','manager')`.
- **Планировщик / крон** — «парсить каждое утро» через `mcp__scheduled-tasks__*`. Пока только ручной запуск.
- **Batch API для других воркеров** — типа «Instantly-бот сам создаёт джоб». Пока только через UI.
- **Дедуп внутри News-выдачи** — сохраняем поведение оригинала (одна ссылка в двух запросах = 2 строки, Outscraper-совместимо).
- **Ретенция / автоочистка** — джобы храним навечно, как Yandex Maps. Cron-очистка — потом.
- **Централизованный пул прокси** — прокси per-job из textarea, как в оригинале и Yandex Maps.
- **Метрики / Grafana** — сколько джобов в очереди, среднее время, успешность — потом.
- **Retries на transient-ошибки** — captcha → статус `captcha`, ждёт ручного перезапуска. Auto-retry со сменой прокси — потом.
- **Google auth / login-required cookies** — парсер публичный, cookies не таскает.

## Риски и открытые вопросы

- **Google может капчить чаще чем Yandex.** Оригинал ловит `captcha` и уходит в статус — это ОК, но частота ловли будет выше. Стратегия — качественные прокси в per-job textarea. Долгосрочно — auto-rotate + retry, но не в этом PR.
- **Playwright + Chromium память.** Прод-сервер один (`139.60.162.12`), там уже Yandex Maps. Если оба одновременно активны + другие воркеры — возможен OOM. Мониторим в первую неделю, поднимаем `CONCURRENCY=2` только если запас есть.
- **Формат CSV News должен совпасть с Outscraper 1-в-1.** У Jacob'a `shared/export.ts` уже так делает — берём как есть. При релизе сверить с примером Outscraper CSV, что у команды на руках.

## Оценка

**~2–3 дня работы:**
- День 1: миграция + Supabase-таблицы + Next.js API-роуты + компоненты UI (Maps + News)
- День 2: `services/googleparsers/` + Dockerfile + `worker-googleparsers` + integration test локально
- День 3: `docker-compose.prod.yml` + `.env`-инструкция + smoke test на прод + фикс findings

## Ссылки

- Оригинал: `G:\PycharmProjects\google-maps-news-parsers` (HANDOFF.md, README.md)
- Reference-паттерн: `app/src/components/parsers/YandexMapsParserView.tsx`, `services/yandexmaps/`, `supabase/migrations/20260213_0003_create_yandex_maps_tables.sql`
- Портальная страница: `app/src/app/parsers/page.tsx`
