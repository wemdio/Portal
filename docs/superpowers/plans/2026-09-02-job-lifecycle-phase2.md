# Job Lifecycle, этап 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести на единый жизненный цикл задач парсеры, которые сегодня при рестарте начинают работу заново или полагаются на сброс «running → pending» при старте: поиск, синк чатов продаж, Яндекс.Карты, архив вакансий HH, Яндекс.Директ и очередь `parser_jobs` (HH/ATS/ENG).

**Architecture:** Тот же `createJobRunner` из `app/src/lib/jobs/lifecycle.ts`, что и в этапе 1: захват по аренде, продление таймером, чекпойнт, освобождение при остановке, никакого восстановления при старте. Каждый воркер сохраняет собственный курсор в `checkpoint` и продолжает с него; `progress.column` защищает от зависшего тела задачи. Терминальный статус везде пишут сами раннеры (`manageTerminalStatus: false`).

**Tech Stack:** TypeScript (esbuild-бандлы воркеров), supabase-js через PostgREST, Postgres-миграции, Jest, Python-монитор здоровья.

**Spec:** `docs/superpowers/specs/2026-09-02-job-lifecycle-design.md` (раздел «Порядок внедрения», этап 2).
**Предшественник:** `docs/superpowers/plans/2026-09-02-job-lifecycle-phase1.md` — читать «Рецепт перевода воркера» там же в спеке.

**Правила репозитория:**
- Новых тест-файлов не создавать. Добавление `it()` в существующий файл — только с явного согласия пользователя; в этом плане такого нет.
- Команды из `app/`: `npx jest <path> --silent`, `npm run typecheck:strict`.
- Прод не трогать. Стоп-точка — коммиты и push в `dmitriy_kuladmed`.
- Коммиты на русском, в конце `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Воркеры (`app/worker/**`) исключены из eslint — проверять их типами и сборкой esbuild, не линтером.

## Что НЕ входит в этап 2 и почему

- **Архив чатов продаж** (`sales_chat_archive_jobs`). Работа — один непрерывный ZIP, который многочастно заливается в S3; `dialogs_done` это индикатор, а не курсор, и обнуляется и при восстановлении, и при захвате. Библиотека не даст ничего, а потеря аренды посреди заливки оставит осиротевшую многочастную загрузку. Остаётся как есть.
- **Очередь обхода каталога ЯКарт** (`yandex_maps_catalog_discovery_queue`). Захват и закрытие идут через RPC с общим дневным бюджетом Яндекса, а не через аренду. Её текущий перехват по `claimed_at` в `app/worker/yandexmaps.ts` сохраняется даже после перевода `yandex_maps_jobs`.

## Карта файлов

| Файл | Действие | Ответственность |
|---|---|---|
| `app/worker/search.ts` | переписать | задача 1: поиск на библиотеке |
| `app/src/lib/search/searchParserWorker.ts` | изменить | принять `ctx`, писать чекпойнт, слушать сигнал |
| `app/worker/salesChatLogger.ts` | переписать | задача 2: синк чатов продаж |
| `app/worker/yandexmaps.ts` | переписать | задача 3: ЯКарты, снять восстановление и сторожа |
| `app/src/lib/parsers/yandexMapsWorker.ts` | изменить | принять `ctx`, чекпойнт по этапам |
| `app/worker/hh.ts` | изменить | задача 4: архив HH и Яндекс.Директ |
| `app/src/lib/parsers/hhArchive/runner.ts` | изменить | курсор по чанкам |
| `app/src/lib/parsers/yandexDirect/runner.ts` | изменить | курсор по запросам |
| `app/worker/parserJobs.ts` | переписать | задача 5: общий раннер `parser_jobs` |
| `app/worker/engHiring.ts` | изменить | задача 5: тот же раннер |
| `services/health-check/main.py` | изменить | задача 6: монитор видит `processing` |
| `docker-compose.prod.yml` | изменить | сроки остановки, переменные аренды |
| `drain-worker.sh` | изменить | убирать таблицы по мере перевода |

---

### Task 1: Поиск (`search_parser_jobs`)

Самый простой: продолжение с места уже реализовано (`searchParserWorker.ts` считает `resumeFrom` из `processed_queries`), нужен только перевод владения.

**Files:**
- Modify: `app/src/lib/search/searchParserWorker.ts`
- Modify: `app/worker/search.ts` (переписать)
- Modify: `docker-compose.prod.yml` (сервис `worker-search`)
- Modify: `drain-worker.sh` (убрать `search_parser_jobs` из `tracked_tables`)

- [x] **Step 1: Принять контекст в раннере**

В `app/src/lib/search/searchParserWorker.ts` добавить рядом с существующими экспортами:

```ts
export interface SearchParserRunContext {
  signal: AbortSignal;
  runToken: string;
  /** Возвращает false — задачу перехватили: прекратить работу. */
  saveCheckpoint(data: { processed_queries: number }): Promise<boolean>;
}
```

Расширить сигнатуру `runSearchParserJob(jobId: string, ctx?: SearchParserRunContext)`.

Внутри главного цикла по запросам (там, где уже пишется `processed_queries`, около строк 1373 и 1401) после записи прогресса добавить:

```ts
    if (ctx) {
      const owned = await ctx.saveCheckpoint({ processed_queries: processedQueries });
      if (!owned) return; // строку перехватили, новый владелец продолжит
    }
    if (ctx?.signal.aborted) return; // остановка: статус не трогаем, продолжит сосед
```

Важно: при выходе по сигналу НЕ писать терминальный статус — строка должна остаться `running`, аренду отпустит библиотека. Проверить, что существующие `try/finally` в этом файле не запишут `failed` на этом пути; если записывают — обернуть проверкой `ctx?.signal.aborted`.

Все терминальные записи в этом файле (`completed` и `failed`) ограничить владельцем: добавить `.eq('run_token', ctx.runToken)` там, где `ctx` есть, и оставить как есть, когда его нет.

- [x] **Step 2: Переписать воркер**

Заменить содержимое `app/worker/search.ts`:

```ts
/**
 * Search parser worker. Владение задачей — единый жизненный цикл
 * (lib/jobs/lifecycle.ts): аренда, чекпойнт по обработанным запросам,
 * освобождение при остановке. Сброса running → pending при старте больше нет:
 * брошенную задачу определяет истёкшая аренда.
 *
 * Продолжение с места здесь было и раньше: раннер считает resumeFrom из
 * processed_queries. Новое — то, что задача доживает до этого продолжения
 * при деплое, а не откатывается в очередь целиком.
 */

import { runSearchParserJob } from '@/lib/search/searchParserWorker';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const MAX_CONCURRENCY = Math.max(1, Number(process.env.SEARCH_CONCURRENCY ?? '5'));
/**
 * Аренда: живость процесса. Продление идёт таймером каждые lease/3, поэтому
 * порог короткий — упавший воркер отдаёт задачу за три минуты.
 */
const LEASE_SECONDS = Math.max(60, Number(process.env.SEARCH_LEASE_SECONDS ?? '180'));
/**
 * Порог остановки прогресса: живость работы. processed_queries двигается после
 * каждого запроса поисковика. Арифметика восстановления: порог (10 мин) +
 * не больше одной аренды (3 мин) + не больше одного опроса (30 с) ≈ 13,5 мин,
 * это должно оставаться ниже порога монитора здоровья (HEALTH_JOB_STUCK_MIN,
 * 20 мин). Меняя любое слагаемое, сверяй сумму.
 */
const STALL_MS = Math.max(60_000, Number(process.env.SEARCH_STALL_MINUTES ?? '10') * 60_000);
const WORKER_ID = `search-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

async function main(): Promise<void> {
  log('info', `Starting Search worker (pid=${process.pid}, concurrency=${MAX_CONCURRENCY}, lease=${LEASE_SECONDS}s)`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const runner = createJobRunner<{ id: string }, { processed_queries: number }>({
    table: 'search_parser_jobs',
    workerId: WORKER_ID,
    statuses: { pending: 'pending', running: 'running', done: 'completed', failed: 'failed' },
    leaseSeconds: LEASE_SECONDS,
    concurrency: MAX_CONCURRENCY,
    manageTerminalStatus: false,
    progress: { column: 'processed_queries', stalledAfterMs: STALL_MS },
    claimPatch: () => ({ started_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason, completed_at: new Date().toISOString() }),
    shutdownGraceMs: 5_000,
    log,
    run: async (job, ctx) => {
      log('info', `Running search job ${job.id}${ctx.checkpoint ? ' (RESUME)' : ''}`);
      await runSearchParserJob(job.id, {
        signal: ctx.signal,
        runToken: ctx.runToken,
        saveCheckpoint: ctx.saveCheckpoint,
      });
    },
  });

  const onSignal = (sig: string) => {
    markShuttingDown();
    log('info', `${sig} received — releasing leases`);
    void runner.shutdown().catch((err) => log('error', 'shutdown failed', err));
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce: () => runner.pollOnce(),
    realtimeTables: ['search_parser_jobs'],
  });
  await runner.shutdown();
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
```

Сверить `MAX_CONCURRENCY` с текущим значением в файле до правки и сохранить его, а не выдумывать новое.

- [x] **Step 3: Compose и drain**

`docker-compose.prod.yml`, сервис `worker-search`: `stop_grace_period: 30m` → `30s`, добавить `- SEARCH_LEASE_SECONDS=${SEARCH_LEASE_SECONDS:-180}` и `- SEARCH_STALL_MINUTES=${SEARCH_STALL_MINUTES:-10}` в `environment`.

`drain-worker.sh`: убрать `"search_parser_jobs"` из `tracked_tables`; в `is_lifecycle_managed_worker` добавить ветку `worker-search`.

- [x] **Step 4: Проверить**

```bash
cd app && npm run typecheck:strict && npx jest tests/lib --silent
```
Expected: типы чисто, все тесты проходят.

```bash
bash -n drain-worker.sh
```
Expected: без вывода.

Плюс сборка воркера тем же вызовом esbuild, что и `Dockerfile.worker` (platform node, target node22, `--conditions=react-server`, `--external:playwright`), на `worker/search.ts`.

- [x] **Step 5: Commit**

```bash
git add app/worker/search.ts app/src/lib/search/searchParserWorker.ts docker-compose.prod.yml drain-worker.sh
git commit -m "feat(search): парсер поиска на едином жизненном цикле задач

Владение по аренде вместо сброса running→pending при старте; чекпойнт по
обработанным запросам, продолжение с места переживает деплой.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Синк чатов продаж (`sales_chat_sync_runs`)

Маленький и изолированный: монитор здоровья эту таблицу не наблюдает, `accounts_done` — готовый курсор по списку аккаунтов, синк каждого аккаунта идемпотентен через `last_synced_at`.

**Files:**
- Modify: `app/worker/salesChatLogger.ts`
- Modify: `docker-compose.prod.yml` (сервис `worker-sales-chat-logger`)
- Modify: `drain-worker.sh`

- [x] **Step 1: Отделить планирование от выполнения**

В `app/worker/salesChatLogger.ts` `pollOnce` сегодня делает две вещи: заводит запланированный запуск (`ensureScheduledRun`) и выполняет его. Планирование остаётся вне раннера. Новая структура `pollOnce`:

```ts
  const pollOnce = async (): Promise<boolean> => {
    await ensureScheduledRun();      // как было, вне владения задачей
    return runner.pollOnce();        // захват и выполнение — через библиотеку
  };
```

- [x] **Step 2: Перевести выполнение в раннер**

Тело `runSync` становится функцией `run(job, ctx)`. Внутри цикла по аккаунтам после инкремента `accounts_done` добавить:

```ts
      const owned = await ctx.saveCheckpoint({ accounts_done: done });
      if (!owned || ctx.signal.aborted) return; // перехват или остановка
```

Убрать блок восстановления при старте (безусловный `running → pending` по `sales_chat_sync_runs` и по `sales_chat_accounts.backfill_status`). Для `sales_chat_accounts.backfill_status` восстановление ОСТАВИТЬ: это не таблица задач раннера, у неё нет аренды, и без сброса аккаунт залипнет в `running` навсегда. Убрать только часть про `sales_chat_sync_runs` и явно написать в комментарии, почему вторая половина остаётся.

Конфигурация раннера:

```ts
  const runner = createJobRunner<{ id: string }, { accounts_done: number }>({
    table: 'sales_chat_sync_runs',
    workerId: WORKER_ID,
    statuses: { pending: 'pending', running: 'running', done: 'done', failed: 'error' },
    leaseSeconds: Math.max(60, Number(process.env.SALES_CHAT_LEASE_SECONDS ?? '180')),
    concurrency: 1,
    manageTerminalStatus: false,
    progress: { column: 'accounts_done', stalledAfterMs: STALL_MS },
    claimPatch: () => ({ started_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason }),
    shutdownGraceMs: 5_000,
    log,
    run: async (job, ctx) => { /* тело прежнего runSync */ },
  });
```

Порог `STALL_MS`: синк одного аккаунта — это живая сессия Telegram, аккаунтов немного, но один тяжёлый аккаунт может идти минутами. Взять 15 минут по умолчанию (`SALES_CHAT_STALL_MINUTES`), обосновать в комментарии тем, что монитор эту таблицу не наблюдает, поэтому верхняя граница задаётся не им, а здравым смыслом: пятнадцать минут без единого обработанного аккаунта означают, что сессия висит.

Продолжение с места: при захвате прочитать `ctx.checkpoint?.accounts_done` и пропустить столько аккаунтов из начала списка. Порядок списка обязан быть стабильным между запусками — проверить, что выборка аккаунтов идёт с явным `order by`, и добавить его, если нет. Написать это в комментарии: без стабильного порядка курсор по номеру бессмысленен.

Держать `concurrency: 1` и одну реплику: живые сессии Telegram нельзя открывать из двух процессов (тот же класс проблем, что описан у `worker-tg-parser` в compose).

- [x] **Step 3: Compose и drain**

`worker-sales-chat-logger`: `stop_grace_period: 5m` → `30s`; добавить переменные аренды и порога. В `drain-worker.sh` добавить сервис в `is_lifecycle_managed_worker` (в `tracked_tables` этой таблицы нет, проверить и не трогать лишнего).

- [x] **Step 4: Проверить**

```bash
cd app && npm run typecheck:strict && npx jest tests/lib --silent
```
Expected: чисто. Плюс esbuild на `worker/salesChatLogger.ts` и `bash -n drain-worker.sh`.

- [x] **Step 5: Commit**

```bash
git add app/worker/salesChatLogger.ts docker-compose.prod.yml drain-worker.sh
git commit -m "feat(sales-chat): синк чатов на едином жизненном цикле задач

Курсор по обработанным аккаунтам вместо сброса при старте; сброс
backfill_status у самих аккаунтов оставлен — у них нет аренды.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Яндекс.Карты (`yandex_maps_jobs`)

Самая большая выгода: снимаются два восстановления при старте и сторож, который переводит живые задачи в `failed`. Продолжение с места здесь уже работает — оба этапа пересчитывают остаток от сохранённого в базе.

**Files:**
- Modify: `app/worker/yandexmaps.ts` (переписать основную часть)
- Modify: `app/src/lib/parsers/yandexMapsWorker.ts` (принять `ctx`)
- Modify: `docker-compose.prod.yml` (сервис `worker-yandexmaps`)
- Modify: `drain-worker.sh`

- [x] **Step 1: Снять восстановление и сторожа**

Из `app/worker/yandexmaps.ts` удалить:
- блок восстановления свежих `running` → `pending`;
- блок «зомби»: `running` старше 15 минут → `failed` с `progress_stage='stuck_recovered'`;
- сторож на `setInterval` каждые 5 минут, делающий то же самое;
- graceful-requeue собственных задач при выходе.

СОХРАНИТЬ: восстановление очереди обхода каталога (`yandex_maps_catalog_discovery_queue` по `claimed_at` старше 120 минут) и весь код обхода каталога — он не переводится, у него свой захват через RPC и общий дневной бюджет. Написать это в комментарии на месте удалённых блоков.

СОХРАНИТЬ: `startWorkerHeartbeat` и healthcheck по файлу пульса — они ловят мёртвый цикл событий на уровне контейнера, это другой слой защиты, чем аренда.

Поведенческое изменение, которое надо описать в комментарии и в отчёте: задачи больше не уходят в `failed` с формулировкой `stuck_recovered`. Вместо этого зависшая задача перестаёт продлевать аренду и её подбирает следующий опрос, продолжая с сохранённого места. Пользователь вместо ошибки видит продолжение.

- [x] **Step 2: Раннер**

```ts
  const runner = createJobRunner<{ id: string; job_type?: string }, never>({
    table: 'yandex_maps_jobs',
    workerId: WORKER_ID,
    statuses: { pending: 'pending', running: 'running', done: 'completed', failed: 'failed' },
    leaseSeconds: Math.max(60, Number(process.env.YANDEXMAPS_LEASE_SECONDS ?? '300')),
    concurrency: MAX_CONCURRENCY,
    manageTerminalStatus: false,
    progress: { column: 'processed_organizations', stalledAfterMs: STALL_MS },
    select: 'job_type',
    claimPatch: () => ({ updated_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason }),
    shutdownGraceMs: 10_000,
    log,
    run: async (job, ctx) => { /* выбор этапа по job_type, как сейчас */ },
  });
```

Проблема, которую надо решить осознанно и описать в отчёте: этап сбора ссылок двигает `processed_links`, а этап разбора организаций — `processed_organizations`. Библиотека принимает ОДНУ колонку прогресса. Варианты: (а) следить за `updated_at`, который триггер обновляет при любой записи в строку — это покрывает оба этапа, но реагирует и на посторонние записи; (б) выбирать колонку по `job_type` при конфигурации раннера — нельзя, раннер один на таблицу; (в) добавить в библиотеку поддержку колонки, вычисляемой из строки задачи. Рекомендуется (а) — `updated_at` двигают именно рабочие записи прогресса, и триггер уже существует. Проверить по миграции, что триггер `updated_at` действительно стоит на этой таблице, и что посторонних частых записей в строку нет.

Порог остановки прогресса: у ЯКарт один шаг между записями прогресса может быть длинным (медленные прокси). Посмотреть, как часто пишется прогресс в `app/src/lib/parsers/yandexMapsWorker.ts`, и выбрать порог с запасом от самого долгого нормального промежутка, но так, чтобы сумма (порог + аренда + опрос) оставалась ниже 20 минут монитора. Если запас не сходится, поднять `HEALTH_JOB_STUCK_MIN` и сказать об этом явно.

- [x] **Step 3: Чекпойнт и сигнал в раннере этапов**

В `app/src/lib/parsers/yandexMapsWorker.ts` принять контекст (`signal`, `runToken`, `saveCheckpoint`), передавать `ctx.signal` в паузы и сетевые вызовы, и на границах (после порции ссылок, после каждой организации) звать `ctx.saveCheckpoint`. Содержимое чекпойнта минимальное: этап и счётчики, поскольку фактическое продолжение и так считается из сохранённых организаций и ссылок. Терминальные записи ограничить `run_token`, как в этапе 1.

- [x] **Step 4: Compose и drain**

`worker-yandexmaps`: `stop_grace_period: 60s` оставить (60 секунд нужны браузеру на закрытие), добавить переменные аренды и порога. Healthcheck по пульсу и метку autoheal НЕ трогать. В `drain-worker.sh` убрать `yandex_maps_jobs` из `tracked_tables` и добавить сервис в `is_lifecycle_managed_worker`.

- [x] **Step 5: Проверить**

```bash
cd app && npm run typecheck:strict && npx jest tests/lib tests/migrations --silent
```
Expected: чисто. Плюс esbuild на `worker/yandexmaps.ts`, `bash -n drain-worker.sh`, и разбор `docker-compose.prod.yml` через js-yaml.

- [x] **Step 6: Commit**

```bash
git add app/worker/yandexmaps.ts app/src/lib/parsers/yandexMapsWorker.ts docker-compose.prod.yml drain-worker.sh
git commit -m "feat(yandexmaps): владение задачей по аренде, без перевода живых задач в ошибку

Сняты два восстановления при старте и сторож, который помечал зависшие
задачи как stuck_recovered: теперь задача не продлевает аренду и её
подбирает следующий опрос, продолжая с сохранённого места. Обход каталога
и пульс контейнера не тронуты.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Архив HH и Яндекс.Директ (`hh_archive_jobs`, `yandex_direct_jobs`)

У обеих таблиц статус выполнения — `processing`, а не `running`, и обе имеют естественный цикл (чанки и запросы), где курсор сохраняется тривиально.

**Files:**
- Modify: `app/worker/hh.ts`
- Modify: `app/src/lib/parsers/hhArchive/runner.ts`
- Modify: `app/src/lib/parsers/yandexDirect/runner.ts`
- Modify: `services/health-check/main.py`
- Modify: `docker-compose.prod.yml`
- Modify: `drain-worker.sh`

- [x] **Step 1: Два раннера в одном воркере**

`app/worker/hh.ts` обслуживает несколько таблиц. Завести отдельный `createJobRunner` на каждую и опрашивать их по очереди в одном `pollOnce`:

```ts
  const archiveRunner = createJobRunner<{ id: string }, { processed_chunks: number }>({
    table: 'hh_archive_jobs',
    statuses: { pending: 'pending', running: 'processing', done: 'completed', failed: 'failed' },
    progress: { column: 'processed_chunks', stalledAfterMs: STALL_MS },
    /* … */
  });
  const directRunner = createJobRunner<{ id: string }, { processed_requests: number }>({
    table: 'yandex_direct_jobs',
    statuses: { pending: 'pending', running: 'processing', done: 'completed', failed: 'failed' },
    // Колонка называется processed_requests (миграция 20260517_0001).
    // processed_queries на этой таблице нет — это колонка search_parser_jobs.
    progress: { column: 'processed_requests', stalledAfterMs: STALL_MS },
    /* … */
  });
```

и

```ts
  const archivePolled = await archiveRunner.pollOnce();
  const directPolled = await directRunner.pollOnce();
  if (archivePolled || directPolled) return true;
```

Опрашивать раннеры ЧЕРЕЗ КОРОТКОЕ ЗАМЫКАНИЕ (`a.pollOnce() || b.pollOnce()`) нельзя: `pollOnce` отвечает true не только когда задачу взяли, но и когда все слоты раннера заняты (в этом случае библиотека спит 500 мс и возвращает true, чтобы цикл не ушёл ждать realtime на 30 секунд). При `concurrency: 1` это значит, что занятый первый раннер отвечает true всё время работы своей задачи — часами, — и до второй очереди опрос не доходит вовсе. Это правило действует и в задаче 5, когда в этот же воркер добавятся раннеры `parser_jobs`: сначала опросить все, потом сложить ответы.

Оба останавливать в обработчике сигнала и после цикла. Убрать из файла восстановление `processing` старше 30 минут для обеих таблиц и глобальные мьютексы `archiveJobActive` / `yandexDirectJobActive` — их роль теперь играет `concurrency: 1` у соответствующего раннера. Проверить, что мьютексы больше нигде не читаются.

- [x] **Step 2: Курсоры**

`app/src/lib/parsers/hhArchive/runner.ts`: цикл по чанкам уже пишет `processed_chunks`; принять `ctx`, после каждого чанка звать `ctx.saveCheckpoint({ processed_chunks })`, а при старте пропускать первые `ctx.checkpoint?.processed_chunks` чанков. Порядок чанков обязан быть детерминированным — проверить и, если он зависит от порядка выборки из базы, добавить явную сортировку и сказать об этом.

`app/src/lib/parsers/yandexDirect/runner.ts`: то же по запросам.

В обоих: передавать `ctx.signal` в паузы и запросы; при остановке выходить без терминальной записи; терминальные записи ограничить `run_token`.

- [x] **Step 3: Монитор здоровья — В ТОМ ЖЕ КОММИТЕ, не отдельным**

`services/health-check/main.py`, записи `JobMonitorSpec` для `hh_archive_jobs` и `yandex_direct_jobs`: снять `updated_column="updated_at"` у обеих и добавить `"processing"` в оба набора `active_statuses`.

Почему это нельзя откладывать. У обеих таблиц есть безусловный триггер на `updated_at` (`trg_hh_archive_jobs_updated_at`, `supabase/migrations/20260516_0001:105`; `trg_yandex_direct_jobs_updated_at`, `20260517_0001:113`) — он срабатывает на ЛЮБОМ `UPDATE` строки. А продление аренды — это тоже `UPDATE` строки, раз в `аренда/3`. То есть с момента перевода `updated_at` у живого исполнителя свеж всегда, даже когда задача не сдвинулась ни на чанк: `activity_secs` в мониторе никогда не дорастает до порога, и алерт «Долго висит» для этих двух очередей молча выключается. Без `updated_column` монитор считает простой по отпечатку прогресса (колонки в самой спецификации) — этот путь уже работает на бою для `search_parser_jobs` и `yandex_maps_jobs`.

Ту же ловушку проверяли на всех остальных спецификациях с `updated_column="updated_at"` — они безопасны, трогать их не нужно: у `website_inn_lookup_jobs`, `crypto_payment_jobs`, `large_score_jobs`, `tg_scan_jobs`, `tg_transcribe_jobs` триггера на `updated_at` нет вовсе; у `parser_jobs` (задача 5) нет ни триггера, ни `updated_column`; `base_constructor_jobs` смотрит на `started_at`, а его продление аренды не пишет.

Статусы правятся здесь же и по той же причине — иначе эти две очереди становятся ненаблюдаемыми дважды. Сегодня монитор не видит их выполнение вовсе (`active_statuses` = `("pending","running")`, а воркеры пишут `processing`), и снятие `updated_column` без добавления `processing` ничего бы не починило: считать простой стало бы не по чему, потому что строки в выборку не попадают.

Прецедент, ради которого шаг вынесен в тот же коммит: при переводе Яндекс.Карт (задача 3) ровно это и обнаружилось — правка воркера без правки монитора оставляла бы очередь без единственного внешнего наблюдателя, и заметить это по логам было бы нечем.

- [x] **Step 4: Compose и drain**

Сроки остановки для `worker-hh` привести к 30 секундам. Отдельно отметить в комментарии, что прежние 3 часа не соблюдались ни разу: скрипт остановки всегда бил через 15 секунд.

`drain-worker.sh`: `hh_archive_jobs` и `yandex_direct_jobs` в `tracked_tables` отсутствуют — проверить и не трогать. Сервис `worker-hh` в `is_lifecycle_managed_worker` НЕ добавлять на этом шаге: он всё ещё обслуживает `parser_jobs`, которые переводятся в задаче 5.

- [x] **Step 5: Проверить**

```bash
cd app && npm run typecheck:strict && npx jest tests/lib --silent
cd services/health-check && python -c "import ast,sys; ast.parse(open('main.py',encoding='utf-8').read()); print('syntax ok')"
```
Expected: чисто. Плюс esbuild на `worker/hh.ts`.

- [x] **Step 6: Commit**

```bash
git add app/worker/hh.ts app/src/lib/parsers/hhArchive/runner.ts app/src/lib/parsers/yandexDirect/runner.ts services/health-check/main.py docker-compose.prod.yml
git commit -m "feat(hh): архив вакансий и Яндекс.Директ на едином жизненном цикле

Курсор по чанкам и по запросам вместо перезапуска с нуля; мьютексы в
памяти заменены ограничением параллельности раннера.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Очередь `parser_jobs` (HH, ATS, ENG-найм)

Последняя и самая осторожная: курсора здесь нет, продолжение означает повторный проход (спасает только дедупликация на уровне базы). Выгода — корректность при нескольких репликах и отсутствие сброса чужих задач при старте.

**Files:**
- Modify: `app/worker/parserJobs.ts`
- Modify: `app/worker/hh.ts`
- Modify: `app/worker/engHiring.ts`
- Modify: `docker-compose.prod.yml`
- Modify: `drain-worker.sh`

- [x] **Step 1: Общая фабрика раннера**

`app/worker/parserJobs.ts` сейчас экспортирует `claimParserJob` и `recoverRunningParserJobs`. Заменить их одной фабрикой:

```ts
/**
 * Общий раннер очереди parser_jobs. Тип парсера в строке (`parser_type`)
 * определяет, кто её берёт: HH-воркер не должен трогать задачи ENG-найма и
 * наоборот, поэтому фильтр по типу входит в захват.
 *
 * Курсора у этих задач нет: перехваченная задача проходит заново, а от
 * дублей защищает уникальный индекс на результатах. Это то же поведение,
 * что было при сбросе running → pending, только без риска отобрать задачу
 * у живого исполнителя.
 */
export function createParserJobRunner(opts: {
  parserTypes: string[];
  workerId: string;
  log: WorkerLogger;
  concurrency?: number;
  run(jobId: string, ctx: JobContext<never>): Promise<void>;
}): JobRunner
```

Фильтр по `parser_type` — это отбор кандидатов, которого сейчас в библиотеке нет. Проверить `app/src/lib/jobs/lifecycle.ts`: если опции фильтра по дополнительному условию нет, добавить её (`where?: Array<[column, value]>`, применяемая и к выборке кандидата, и к CAS-обновлению в обоих путях захвата) и описать в докблоке. Это правка библиотеки — вынести её отдельным коммитом ПЕРЕД правкой воркеров и прогнать `npx jest tests/lib/jobLifecycle.test.ts`.

- [x] **Step 2: Подключить оба воркера**

`app/worker/hh.ts` и `app/worker/engHiring.ts` создают свои раннеры через фабрику с нужным набором типов и своим `run`, который вызывает существующие `runHHParserJob` / `runAtsParserJob` / `runEngHiringParserJob`. Убрать `recoverRunningParserJobs` из обоих. Убрать мьютексы `atsJobActive` и `engHiringJobActive`.

Порог прогресса: `parser_jobs` пишет `total_parsed` и `progress_percent`. Взять `total_parsed` как колонку прогресса; убедиться, что она двигается регулярно, и подобрать порог по тем же правилам суммы.

**ОТСТУПЛЕНИЕ ПРИ РЕАЛИЗАЦИИ (02.09.2026, коммит 6bfd4c81): порог прогресса НЕ подключён ни у одного из трёх типов — ни `total_parsed`, ни `progress_percent`.** Задачам 6 и 7 это не переигрывать. Проверка по коду дала числа, которые не влезают в бюджет (порог + аренда 3 мин + опрос 30 с < HEALTH_JOB_STUCK_MIN 20 мин, то есть порог ≤ ~16,5 мин):

- `total_parsed` у ENG-найма пишется трижды за всю задачу (0, 0 и итог), а у ATS двигается раз в 25 бордов и только если среди них нашлась вакансия; весь этап обогащения (до 300 компаний) не двигает его вовсе. Как признак живости не годится.
- `progress_percent` двигается у всех трёх, но законные промежутки больше потолка: у HH этап разбиения ограничен `HH_PARTITION_TIMEOUT_MS` (5 мин) + 30 с на термин сверх трёх — до 13,5 мин на запросе из 20 терминов; у ENG один процентный пункт при `companies_limit` 25000 стоит ~450 бордов, а пейсинг workday — 2 борда в 1,5 с, то есть от 5,7 мин до часа на пункт; у ATS на этапе обогащения процент пишется раз в 20 компаний, каждая из которых может встать на Clearbit.

Раннеры у типов при этом РАЗДЕЛЬНЫЕ (`hh.ts` заводит свой на `hh_vacancies` и свой на `ats_companies` — у них разная параллельность), так что настройка не общая; ATS не получил порог по причине выше, а не из-за одной настройки на воркер.

Цена ложного срабатывания здесь выше пропуска: курсора нет, брошенная аренда означает повтор задачи С НУЛЯ и тысячи внешних запросов заново. Живость работы оставлена монитору здоровья: спецификация `parser_jobs` в `services/health-check/main.py` считает простой по отпечатку из пяти колонок прогресса (продление аренды в него не входит) и шлёт «Долго висит» через 20 минут — правки монитора эта задача не потребовала. Подробности и арифметика — в докблоке `createParserJobRunner` (`app/worker/parserJobs.ts`).

- [x] **Step 3: Compose и drain**

Сроки остановки `worker-hh` и `worker-eng-hiring` — 30 секунд. Добавить оба сервиса в `is_lifecycle_managed_worker` и убрать `parser_jobs` из `tracked_tables`.

- [x] **Step 4: Проверить**

```bash
cd app && npm run typecheck:strict && npx jest --silent
```
Expected: весь набор зелёный. Плюс esbuild на `worker/hh.ts` и `worker/engHiring.ts`, `bash -n drain-worker.sh`.

- [x] **Step 5: Commit**

```bash
git add app/worker/parserJobs.ts app/worker/hh.ts app/worker/engHiring.ts docker-compose.prod.yml drain-worker.sh
git commit -m "feat(parser-jobs): очередь HH/ATS/ENG на едином жизненном цикле

Захват с фильтром по типу парсера вместо сброса всех running при старте:
воркер больше не может отобрать задачу у живого соседа.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Монитор здоровья — сверка остальных спецификаций

Найденный при разведке дефект, не связанный с переводом.

**`hh_archive_jobs` и `yandex_direct_jobs` здесь БОЛЬШЕ НЕ ТРОГАЕМ.** Обе спецификации (и `active_statuses` с `processing`, и снятие `updated_column`) правятся в задаче 4, в одном коммите с переводом их воркера, — иначе между коммитами эти очереди остаются без наблюдателя. Если задача 4 уже выполнена, проверить, что там это сделано, и на этом по ним закончить.

Остаток задачи — сверка ВСЕХ ОСТАЛЬНЫХ спецификаций.

**Files:**
- Modify: `services/health-check/main.py`

- [ ] **Step 1: Сверить наборы статусов у остальных таблиц**

Для каждой оставшейся таблицы сверить набор активных статусов с тем, что реально пишет соответствующий воркер, и перечислить в отчёте все расхождения. Исправлять только явные, не додумывая.

Заодно проверить тем же способом ловушку `updated_at` (описана в задаче 4, Step 3): у спецификации с `updated_column="updated_at"` таблица не должна иметь безусловного триггера на эту колонку, если её воркер уже переехал на аренду. На момент составления плана проверены все и опасны только две — обе в задаче 4; шаг нужен на случай, если за время этапа добавились новые.

- [ ] **Step 2: Проверить**

```bash
cd services/health-check && python -c "import ast,sys; ast.parse(open('main.py',encoding='utf-8').read()); print('syntax ok')"
```
Expected: `syntax ok`.

- [ ] **Step 3: Commit**

```bash
git add services/health-check/main.py
git commit -m "fix(health-check): наборы активных статусов сверены с воркерами

Сплошная сверка оставшихся очередей: где монитор ждал не тот статус,
выполняющиеся задачи не наблюдались вовсе. Архив HH и Яндекс.Директ
исправлены раньше, вместе с переводом их воркера.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Финальная проверка и push

- [ ] **Step 1: Весь набор**

```bash
cd app && npx jest --silent
```
Expected: все файлы проходят, время меньше трёх минут.

- [ ] **Step 2: Типы**

```bash
cd app && npm run typecheck:strict
```
Expected: без ошибок.

- [ ] **Step 3: Сборка всех задетых воркеров**

Прогнать esbuild-вызов из `Dockerfile.worker` на `worker/search.ts`, `worker/salesChatLogger.ts`, `worker/yandexmaps.ts`, `worker/hh.ts`, `worker/engHiring.ts`.
Expected: каждый собирается без предупреждений.

- [ ] **Step 4: Чужие правки**

```bash
git status --porcelain
```
Expected: пусто. Если есть незакоммиченные чужие файлы — не трогать, сообщить.

- [ ] **Step 5: Push**

```bash
git push origin dmitriy_kuladmed
```

Затем отчитаться: ветка, последний коммит, итоги прогона и типов, и отдельно список поведенческих изменений, которые увидит пользователь (в первую очередь исчезновение сообщений `stuck_recovered` у Яндекс.Карт).

---

## Проверка на бою после деплоя (для пользователя)

1. Поиск: запустить парсинг на многих запросах, во время работы перезапустить контейнер. Задача должна продолжиться с того же числа обработанных запросов, а не с нуля.
2. Яндекс.Карты: убедиться, что после деплоя ни одна задача не получила `stuck_recovered`, и что зависшая задача подбирается сама.
3. Через сутки: `select count(*) from search_parser_jobs where status='running' and lease_until < now() - interval '10 minutes'` должно быть 0. Тот же запрос для `yandex_maps_jobs`, `hh_archive_jobs`, `yandex_direct_jobs`, `parser_jobs`, `sales_chat_sync_runs`.
