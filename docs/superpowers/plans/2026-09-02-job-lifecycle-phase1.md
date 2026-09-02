# Job Lifecycle, этап 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Единая библиотека жизненного цикла задач (аренда, жетон, чекпойнт, быстрая передача при остановке), миграция колонок во все таблицы задач, перевод двух пилотных воркеров (конструктор баз, TG-парсер) и упрощение деплоя.

**Architecture:** Библиотека `app/src/lib/jobs/lifecycle.ts` берёт задачу CAS-апдейтом через PostgREST, держит аренду `lease_until` независимым таймером, пишет `checkpoint`, а на SIGTERM обнуляет аренду своих задач (дважды с паузой в секунду) и прерывает `run` через `AbortSignal`. Восстановления при старте нет: брошенная задача = истёкшая или обнулённая аренда, её берёт любая реплика. Деплой перестаёт править базу и списки контейнеров для переведённых воркеров: `docker compose stop --timeout 15`, воркеры передают задачи сами.

**Tech Stack:** TypeScript (Next.js app, esbuild-бандлы воркеров), supabase-js через PostgREST, Postgres-миграции в `supabase/migrations/`, Jest с виртуальными часами, bash-скрипт деплоя в `.semaphore/scheduled-deploy.yml`.

**Spec:** `docs/superpowers/specs/2026-09-02-job-lifecycle-design.md`

**Правила репозитория, которые здесь важны:**
- Новых тест-файлов не пишем, кроме одного согласованного: `app/tests/lib/jobLifecycle.test.ts`. Существующие тесты, которые фиксировали старый механизм, удаляем или режем.
- Команды запускать из `app/`: `npx jest <path>`, `npm run typecheck:strict`.
- Прод не трогаем. Стоп-точка — коммиты и push в ветку `dmitriy_kuladmed`.
- Коммиты: сообщение на русском, в конце строка `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Карта файлов

| Файл | Действие | За что отвечает |
|---|---|---|
| `supabase/migrations/20260902_0001_job_lifecycle_columns.sql` | создать | пять колонок + индекс в 28 таблицах задач |
| `app/src/lib/jobs/lifecycle.ts` | создать | библиотека: захват, аренда, чекпойнт, остановка |
| `app/tests/lib/jobLifecycle.test.ts` | создать | единственный новый тест-файл, виртуальные часы, фейковый Supabase |
| `app/worker/baseConstructor.ts` | переписать | пилот 1: воркер на библиотеке |
| `app/src/app/api/tools/base-constructor/[id]/route.ts` | изменить | убрать перехват задачи из HTTP-роута (это делает воркер) |
| `app/src/lib/tgParser/types.ts` | изменить | `signal`, `initialUsers`, `onLinkDone` в `ParseOptions` |
| `app/src/lib/tgParser/parser.ts` | изменить | прерывание по сигналу, продолжение с набранных пользователей, колбэк «источник обработан» |
| `app/src/lib/tgParser/tgParserJobWorker.ts` | изменить | чекпойнт `{done_links, users}`, продолжение, выход без итога при остановке |
| `app/worker/tgParser.ts` | переписать | пилот 2: воркер на библиотеке |
| `drain-worker.sh` | изменить | убрать списки контейнеров и правку `base_constructor_jobs`/`tg_parser_jobs` |
| `.semaphore/scheduled-deploy.yml` | изменить | шаг 5: `compose stop --timeout 15` перед `force_rm_svc` |
| `docker-compose.prod.yml` | изменить | `stop_grace_period: 30s` пилотам, `BASE_CONSTRUCTOR_LEASE_SECONDS` вместо `BASE_CONSTRUCTOR_STALE_MINUTES` |
| `app/tests/lib/baseConstructorDeployDrain.test.ts` | удалить | фиксировал старый bash-механизм |
| `app/tests/lib/baseConstructorProductionCapacity.test.ts` | изменить | убрать проверку списка реплик в drain-worker.sh |
| `app/tests/lib/engHiringWorkerIsolation.test.ts` | изменить | убрать проверку имени контейнера в drain-worker.sh |
| `app/tests/lib/autoPipelineDeployDrain.test.ts` | изменить | убрать проверки generic-списка контейнеров |

---

### Task 1: Миграция колонок жизненного цикла

**Files:**
- Create: `supabase/migrations/20260902_0001_job_lifecycle_columns.sql`

- [ ] **Step 1: Создать миграцию**

```sql
-- Единый жизненный цикл фоновых задач (spec: docs/superpowers/specs/2026-09-02-job-lifecycle-design.md).
--
-- Пять одинаковых колонок в каждой таблице задач. Ни одна существующая колонка
-- и ни один статус не меняются: экраны и монитор здоровья работают как раньше.
--
--   lease_until  — до какого момента задача арендована исполнителем; истекла или
--                  null при status=running → задачу можно перехватить.
--   run_token    — жетон владения, выписывается при каждом захвате; все записи
--                  исполнителя в строку ограничены «and run_token = свой».
--   worker_id    — имя исполнителя для диагностики.
--   checkpoint   — сохранённый прогресс, структура своя у каждого воркера.
--   attempts     — число падений/потерь аренды; после трёх задача уходит в ошибку.
--
-- Только add column if not exists: миграция идемпотентна, у base_constructor_jobs
-- run_token уже есть (20260901_0002), у he_jobs/ve_jobs уже есть attempts.

do $$
declare
  t text;
  tables text[] := array[
    'base_constructor_jobs',
    'tg_parser_jobs',
    'parser_jobs',
    'hh_archive_jobs',
    'yandex_direct_jobs',
    'search_parser_jobs',
    'sales_chat_archive_jobs',
    'sales_chat_sync_runs',
    'yandex_maps_jobs',
    'yandex_maps_catalog_discovery_queue',
    'tg_outreach_campaigns',
    'tg_outreach_warmup_runs',
    'tg_outreach_jobs',
    'ai_campaigns',
    'ai_caller_jobs',
    'li_campaigns',
    'website_enrichment_jobs',
    'brief_scoring_jobs',
    'crypto_payment_jobs',
    'email_validation_jobs',
    'inn_enrich_jobs',
    'website_inn_lookup_jobs',
    'tg_scan_jobs',
    'tg_transcribe_jobs',
    'client_report_export_jobs',
    'he_jobs',
    've_jobs',
    'client_manual_score_runs'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I add column if not exists lease_until timestamptz', t);
    execute format('alter table public.%I add column if not exists run_token uuid', t);
    execute format('alter table public.%I add column if not exists worker_id text', t);
    execute format('alter table public.%I add column if not exists checkpoint jsonb', t);
    execute format('alter table public.%I add column if not exists attempts int not null default 0', t);
    execute format(
      'create index if not exists %I on public.%I (status, lease_until)',
      t || '_lease_idx', t
    );
    execute format(
      'comment on column public.%I.lease_until is %L',
      t, 'Аренда исполнителя. Истекла или null при running — задачу можно перехватить (lib/jobs/lifecycle.ts).'
    );
  end loop;
end $$;
```

- [ ] **Step 2: Проверить, что все 28 таблиц существуют в миграциях**

Run (из корня репозитория, Git Bash):
```bash
for t in base_constructor_jobs tg_parser_jobs parser_jobs hh_archive_jobs yandex_direct_jobs search_parser_jobs sales_chat_archive_jobs sales_chat_sync_runs yandex_maps_jobs yandex_maps_catalog_discovery_queue tg_outreach_campaigns tg_outreach_warmup_runs tg_outreach_jobs ai_campaigns ai_caller_jobs li_campaigns website_enrichment_jobs brief_scoring_jobs crypto_payment_jobs email_validation_jobs inn_enrich_jobs website_inn_lookup_jobs tg_scan_jobs tg_transcribe_jobs client_report_export_jobs he_jobs ve_jobs client_manual_score_runs; do grep -liE "create table (if not exists )?public\.$t\b" supabase/migrations/*.sql >/dev/null || echo "MISSING $t"; done
```
Expected: пустой вывод (ни одной строки `MISSING`).

- [ ] **Step 3: Прогнать линты миграций**

Run: `cd app && npx jest tests/migrations --silent`
Expected: PASS (новых таблиц нет, grant-линт молчит; миграция не `no-transaction`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260902_0001_job_lifecycle_columns.sql
git commit -m "feat(jobs): колонки единого жизненного цикла задач в 28 таблицах

lease_until / run_token / worker_id / checkpoint / attempts + индекс
(status, lease_until). Только add column if not exists.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Библиотека `lifecycle.ts` — тест (падающий)

**Files:**
- Create: `app/tests/lib/jobLifecycle.test.ts`

Фейковый Supabase здесь — минимальный интерпретатор ровно тех цепочек, которые использует библиотека (см. Task 3): `select().eq().order().limit().maybeSingle()`, `select().eq().or().order().limit().maybeSingle()`, `update().eq().eq().[or()|eq()].select().maybeSingle()`. Всё остальное — не наш случай, фейк бросит.

- [ ] **Step 1: Написать тест**

```ts
/**
 * @jest-environment node
 *
 * Контракты единого жизненного цикла задач (lib/jobs/lifecycle.ts):
 *  - две реплики берут одну pending-задачу — побеждает одна;
 *  - истёкшая или обнулённая аренда перехватывается, живая — нет;
 *  - продление и чекпойнт с чужим run_token не проходят;
 *  - shutdown обнуляет аренду только своих задач и глушит продления;
 *  - исключение в run ниже maxAttempts → pending, на пределе → failed.
 *
 * Время — виртуальное: аренда и таймеры прокручиваются, а не проживаются.
 */

import { __resetShutdownStateForTests } from '@/lib/workerShutdown';
import { createJobRunner, type JobContext } from '@/lib/jobs/lifecycle';

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'lt' | 'or'; col?: string; value?: unknown; raw?: string };

const T0 = Date.parse('2026-09-02T10:00:00.000Z');
let clock = T0;
const now = () => clock;

/** Крошечный PostgREST: строки в памяти, фильтры eq/lt/or(is.null,lt). */
function makeFakeDb(initial: Row[]) {
  const rows: Row[] = initial.map((r) => ({ ...r }));
  const updates: Array<{ patch: Row; matched: number }> = [];

  const matches = (row: Row, filters: Filter[]) =>
    filters.every((f) => {
      if (f.op === 'eq') return row[f.col!] === f.value;
      if (f.op === 'lt') return typeof row[f.col!] === 'string' && (row[f.col!] as string) < (f.value as string);
      // or: 'lease_until.is.null,lease_until.lt."<iso>"' — значение в кавычках, как шлёт библиотека
      return f.raw!.split(',').some((clause) => {
        const [col, op, ...rest] = clause.split('.');
        const val = rest.join('.').replace(/^"|"$/g, '');
        if (op === 'is' && val === 'null') return row[col] == null;
        if (op === 'lt') return typeof row[col] === 'string' && (row[col] as string) < val;
        throw new Error(`fake db: unsupported or-clause ${clause}`);
      });
    });

  const from = () => {
    const filters: Filter[] = [];
    let mode: 'select' | 'update' = 'select';
    let patch: Row = {};
    let orderCol: string | null = null;
    let limit = Infinity;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.update = (p: Row) => { mode = 'update'; patch = p; return q; };
    q.eq = (col: string, value: unknown) => { filters.push({ op: 'eq', col, value }); return q; };
    q.lt = (col: string, value: unknown) => { filters.push({ op: 'lt', col, value }); return q; };
    q.or = (raw: string) => { filters.push({ op: 'or', raw }); return q; };
    q.order = (col: string) => { orderCol = col; return q; };
    q.limit = (n: number) => { limit = n; return q; };
    q.maybeSingle = async () => {
      let hit = rows.filter((r) => matches(r, filters));
      if (orderCol) hit = [...hit].sort((a, b) => String(a[orderCol!]).localeCompare(String(b[orderCol!])));
      hit = hit.slice(0, limit);
      if (mode === 'update') {
        for (const r of hit) Object.assign(r, patch);
        updates.push({ patch, matched: hit.length });
      }
      return { data: hit[0] ? { ...hit[0] } : null, error: null };
    };
    return q;
  };

  return { client: { from } as never, rows, updates };
}

const statuses = { pending: 'pending', running: 'running', done: 'done', failed: 'failed' };
const log = () => {};

function makeRunner(
  db: ReturnType<typeof makeFakeDb>,
  run: (job: Row, ctx: JobContext<Row>) => Promise<void>,
  extra: Record<string, unknown> = {},
) {
  return createJobRunner<Row & { id: string }, Row>({
    table: 'jobs',
    workerId: 'w1',
    statuses,
    leaseSeconds: 60,
    maxAttempts: 3,
    db: db.client,
    now,
    log,
    run: run as never,
    ...extra,
  } as never);
}

/** Отпускает microtask-очередь, чтобы run()/finally успели отработать. */
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());
beforeEach(() => {
  clock = T0;
  jest.setSystemTime(T0);
  __resetShutdownStateForTests();
});

describe('job lifecycle', () => {
  it('two replicas race for one pending job — exactly one wins', async () => {
    const db = makeFakeDb([{ id: 'j1', status: 'pending', created_at: '2026-09-02T09:00:00Z', attempts: 0 }]);
    const runs: string[] = [];
    const runA = makeRunner(db, async () => { runs.push('A'); await new Promise(() => {}); }, { workerId: 'A' });
    const runB = makeRunner(db, async () => { runs.push('B'); await new Promise(() => {}); }, { workerId: 'B' });

    const [gotA, gotB] = await Promise.all([runA.pollOnce(), runB.pollOnce()]);
    await flush();

    expect([gotA, gotB].filter(Boolean)).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(db.rows[0].status).toBe('running');
    expect(typeof db.rows[0].run_token).toBe('string');
    expect(db.rows[0].lease_until).toBe(new Date(T0 + 60_000).toISOString());
  });

  it('reclaims an expired or released lease, never a live one', async () => {
    const db = makeFakeDb([
      { id: 'live', status: 'running', created_at: '1', attempts: 0, run_token: 'x', lease_until: new Date(T0 + 30_000).toISOString() },
      { id: 'expired', status: 'running', created_at: '2', attempts: 0, run_token: 'y', lease_until: new Date(T0 - 1_000).toISOString() },
      { id: 'released', status: 'running', created_at: '3', attempts: 0, run_token: 'z', lease_until: null },
    ]);
    const seen: string[] = [];
    const runner = makeRunner(db, async (job) => { seen.push(job.id as string); }, { concurrency: 3 });

    expect(await runner.pollOnce()).toBe(true);
    expect(await runner.pollOnce()).toBe(true);
    expect(await runner.pollOnce()).toBe(false);
    await flush();

    expect(seen.sort()).toEqual(['expired', 'released']);
    expect(db.rows.find((r) => r.id === 'live')!.run_token).toBe('x');
    // Потеря аренды (crash) считается попыткой, чистая передача (null) — нет.
    expect(db.rows.find((r) => r.id === 'expired')!.attempts).toBe(1);
    expect(db.rows.find((r) => r.id === 'released')!.attempts).toBe(0);
  });

  it('fails a job whose lease was lost maxAttempts times', async () => {
    const db = makeFakeDb([
      { id: 'j', status: 'running', created_at: '1', attempts: 2, run_token: 'old', lease_until: new Date(T0 - 1).toISOString() },
    ]);
    const run = jest.fn(async () => {});
    const runner = makeRunner(db, run, { failedPatch: (reason) => ({ error_message: reason }) });

    expect(await runner.pollOnce()).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(db.rows[0].status).toBe('failed');
    expect(db.rows[0].attempts).toBe(3);
    expect(String(db.rows[0].error_message)).toContain('3');
  });

  it('heartbeat extends the lease; a foreign run_token is rejected and aborts the run', async () => {
    const db = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    let ctxRef: JobContext<Row> | null = null;
    const runner = makeRunner(db, async (_job, ctx) => {
      ctxRef = ctx;
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
    });
    await runner.pollOnce();
    await flush();

    clock += 20_000; jest.setSystemTime(clock);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(db.rows[0].lease_until).toBe(new Date(clock + 60_000).toISOString());

    // Чужой захват: жетон сменился — наш чекпойнт не проходит, run прерывается.
    db.rows[0].run_token = 'stolen';
    expect(await ctxRef!.saveCheckpoint({ page: 5 })).toBe(false);
    expect(db.rows[0].checkpoint).toBeUndefined();
    clock += 20_000; jest.setSystemTime(clock);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(ctxRef!.signal.aborted).toBe(true);
  });

  it('saveCheckpoint stores the checkpoint and renews the lease', async () => {
    const db = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    let ctxRef: JobContext<Row> | null = null;
    const runner = makeRunner(db, async (_job, ctx) => { ctxRef = ctx; await new Promise(() => {}); });
    await runner.pollOnce();
    await flush();

    clock += 5_000; jest.setSystemTime(clock);
    expect(await ctxRef!.saveCheckpoint({ page: 3 })).toBe(true);
    expect(db.rows[0].checkpoint).toEqual({ page: 3 });
    expect(db.rows[0].lease_until).toBe(new Date(clock + 60_000).toISOString());
  });

  it('shutdown releases only its own leases, twice, and silences heartbeats', async () => {
    const db = makeFakeDb([
      { id: 'mine', status: 'pending', created_at: '1', attempts: 0 },
      { id: 'other', status: 'running', created_at: '2', attempts: 0, run_token: 'o', lease_until: new Date(T0 + 50_000).toISOString() },
    ]);
    const runner = makeRunner(db, async (_job, ctx) => {
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
    }, { shutdownGraceMs: 3_000 });
    await runner.pollOnce();
    await flush();
    const before = db.updates.length;

    const done = runner.shutdown();
    await jest.advanceTimersByTimeAsync(5_000);
    await done;

    const releases = db.updates.slice(before).filter((u) => 'lease_until' in u.patch && u.patch.lease_until === null);
    expect(releases).toHaveLength(2);
    expect(db.rows.find((r) => r.id === 'mine')!.lease_until).toBeNull();
    expect(db.rows.find((r) => r.id === 'other')!.lease_until).toBe(new Date(T0 + 50_000).toISOString());
    // После остановки продления не пишутся.
    const after = db.updates.length;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(db.updates.length).toBe(after);
    expect(await runner.pollOnce()).toBe(false);
  });

  it('a thrown run goes back to pending below maxAttempts and to failed at the limit', async () => {
    const db = makeFakeDb([
      { id: 'a', status: 'pending', created_at: '1', attempts: 0 },
      { id: 'b', status: 'pending', created_at: '2', attempts: 2 },
    ]);
    const runner = makeRunner(db, async () => { throw new Error('boom'); }, {
      concurrency: 2,
      failedPatch: (reason) => ({ error_message: reason }),
    });
    await runner.pollOnce();
    await runner.pollOnce();
    await flush();

    const a = db.rows.find((r) => r.id === 'a')!;
    const b = db.rows.find((r) => r.id === 'b')!;
    expect(a.status).toBe('pending');
    expect(a.attempts).toBe(1);
    expect(a.run_token).toBeNull();
    expect(b.status).toBe('failed');
    expect(b.attempts).toBe(3);
    expect(String(b.error_message)).toContain('boom');
  });

  it('manageTerminalStatus=false leaves the terminal status to run()', async () => {
    const db = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    const runner = makeRunner(db, async () => { db.rows[0].status = 'done_by_runner'; }, { manageTerminalStatus: false });
    await runner.pollOnce();
    await flush();
    expect(db.rows[0].status).toBe('done_by_runner');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает (модуля нет)**

Run: `cd app && npx jest tests/lib/jobLifecycle.test.ts`
Expected: FAIL, `Cannot find module '@/lib/jobs/lifecycle'`.

- [ ] **Step 3: Commit**

```bash
git add app/tests/lib/jobLifecycle.test.ts
git commit -m "test(jobs): контракты единого жизненного цикла задач (падающий)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Библиотека `lifecycle.ts` — реализация

**Files:**
- Create: `app/src/lib/jobs/lifecycle.ts`
- Test: `app/tests/lib/jobLifecycle.test.ts`

- [ ] **Step 1: Написать модуль**

```ts
/**
 * Единый жизненный цикл фоновых задач.
 *
 * Одна библиотека вместо самописных claim/recover/resetStuck в каждом воркере.
 * Spec: docs/superpowers/specs/2026-09-02-job-lifecycle-design.md.
 *
 * Что делает:
 *  1. Захват. pending → running с новым run_token и арендой lease_until (CAS по
 *     status). Если pending нет — running с истёкшей (lt now) или обнулённой
 *     (null) арендой. Через PostgREST, без RPC: тот же паттерн, что годами
 *     работает в конструкторе баз.
 *  2. Продление. Пока run() идёт, независимый setInterval продлевает аренду с
 *     фильтром run_token. После markShuttingDown() продления молчат (инцидент
 *     11.08.2026: heartbeat затирал handoff).
 *  3. Чекпойнт. ctx.saveCheckpoint пишет checkpoint + продлевает аренду; false —
 *     строку перехватили, воркер обязан остановиться (мы ещё и abort'им signal).
 *  4. Остановка. shutdown(): markShuttingDown, abort всех run, lease_until=null
 *     своим задачам дважды с паузой в секунду (перебивает продление, ушедшее до
 *     сигнала), ждём run-промисы до shutdownGraceMs. Новая реплика подхватит
 *     задачу на первом опросе.
 *  5. Восстановления при старте НЕТ. Брошенная задача = истёкшая/обнулённая
 *     аренда. Поэтому механизм корректен при любом числе реплик.
 *
 * attempts считает потери аренды (crash/OOM/SIGKILL) и исключения в run().
 * Чистая передача при shutdown (lease_until=null) попыткой не считается —
 * иначе три деплоя подряд роняли бы трёхчасовую задачу.
 */

import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isShuttingDown, markShuttingDown } from '@/lib/workerShutdown';

export type JobLogger = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export interface JobStatuses {
  pending: string;
  running: string;
  done: string;
  failed: string;
}

export interface JobContext<C> {
  jobId: string;
  runToken: string;
  /** Чекпойнт с прошлого захвата или null. */
  checkpoint: C | null;
  /** Взводится при shutdown и при потере аренды. Передавать в fetch/паузы. */
  signal: AbortSignal;
  shouldStop(): boolean;
  /** false — строку перехватили: прекратить работу над задачей. */
  saveCheckpoint(data: C): Promise<boolean>;
  log: JobLogger;
}

/** Минимальный срез supabase-js, который использует библиотека (и который умеет фейк в тестах). */
type DbClient = { from(table: string): any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface JobRunnerOptions<Row extends { id: string }, C> {
  table: string;
  workerId: string;
  statuses: JobStatuses;
  /** Аренда в секундах; продление каждые leaseSeconds/3. */
  leaseSeconds: number;
  /** Сколько потерь аренды / исключений до status=failed. По умолчанию 3. */
  maxAttempts?: number;
  /** Сколько задач одновременно на этой реплике. По умолчанию 1. */
  concurrency?: number;
  /** Колонка порядка захвата pending. По умолчанию created_at. */
  orderBy?: string;
  /** Что читать в job для run(). id, checkpoint, attempts добавляются всегда. */
  select?: string;
  /** Дополнительные поля при захвате (например started_at). */
  claimPatch?: () => Record<string, unknown>;
  /** Дополнительные поля при переводе в failed (например error_message). */
  failedPatch?: (reason: string) => Record<string, unknown>;
  /**
   * true (по умолчанию): библиотека сама ставит done/failed/pending по итогу run().
   * false: run() пишет терминальный статус сам (конструктор баз, TG-парсер);
   * библиотека тогда только держит аренду и отпускает её при остановке.
   */
  manageTerminalStatus?: boolean;
  /** Сколько ждать run-промисы после сигнала. По умолчанию 10 с. */
  shutdownGraceMs?: number;
  now?: () => number;
  db?: DbClient;
  log: JobLogger;
  run(job: Row & { checkpoint: C | null; attempts: number }, ctx: JobContext<C>): Promise<void>;
}

export interface JobRunner {
  /** Один опрос: взял задачу → true (зови снова), нечего брать → false. */
  pollOnce(): Promise<boolean>;
  /** Идемпотентно. Отпускает аренды, прерывает run(), ждёт до shutdownGraceMs. */
  shutdown(): Promise<void>;
  activeJobIds(): string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createJobRunner<Row extends { id: string }, C = unknown>(
  opts: JobRunnerOptions<Row, C>,
): JobRunner {
  const db: DbClient | null = opts.db ?? (supabaseAdmin as DbClient | null);
  if (!db) throw new Error('createJobRunner: supabaseAdmin is not configured');
  const {
    table, workerId, statuses, log,
    maxAttempts = 3, concurrency = 1, orderBy = 'created_at',
    manageTerminalStatus = true, shutdownGraceMs = 10_000,
  } = opts;
  const now = opts.now ?? Date.now;
  const leaseMs = Math.max(1_000, opts.leaseSeconds * 1_000);
  const heartbeatMs = Math.max(1_000, Math.floor(leaseMs / 3));
  // run_token обязателен в выборке: по нему ограждаются все дальнейшие записи.
  const baseSelect = 'id, checkpoint, attempts, run_token';
  const select = opts.select ? `${baseSelect}, ${opts.select}` : baseSelect;

  const iso = (ms: number) => new Date(ms).toISOString();
  const leaseUntil = () => iso(now() + leaseMs);
  /**
   * PostgREST-фильтр «аренда истекла или обнулена». Значение в кавычках:
   * внутри ISO-даты есть точки, без кавычек грамматика or=(…) режет их как
   * разделители оператора.
   */
  const expiredFilter = () => `lease_until.is.null,lease_until.lt."${iso(now())}"`;
  const clearOwnership = { lease_until: null, run_token: null, worker_id: null };

  type Owned = { runToken: string; abort: AbortController; promise: Promise<void> };
  const owned = new Map<string, Owned>();
  let stopping = false;

  /** UPDATE с ограждением по жетону. true — строка наша (или БД моргнула), false — перехвачена. */
  async function fencedUpdate(jobId: string, runToken: string, patch: Record<string, unknown>): Promise<boolean> {
    const { data, error } = await db!
      .from(table)
      .update(patch)
      .eq('id', jobId)
      .eq('status', statuses.running)
      .eq('run_token', runToken)
      .select('id')
      .maybeSingle();
    if (error) {
      // Сбой сети — не доказательство потери владения: все записи и так
      // ограждены жетоном, а ложный abort стоил бы часов работы.
      log('warn', `[${table}] fenced update failed for ${jobId}: ${error.message}`);
      return true;
    }
    return !!data;
  }

  async function claimPending(): Promise<(Row & { checkpoint: C | null; attempts: number }) | null> {
    const { data: candidate } = await db!
      .from(table)
      .select('id, attempts')
      .eq('status', statuses.pending)
      .order(orderBy, { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!candidate) return null;
    const runToken = randomUUID();
    const { data } = await db!
      .from(table)
      .update({
        status: statuses.running,
        run_token: runToken,
        worker_id: workerId,
        lease_until: leaseUntil(),
        ...(opts.claimPatch?.() ?? {}),
      })
      .eq('id', candidate.id)
      .eq('status', statuses.pending)
      .select(select)
      .maybeSingle();
    return data ?? null;
  }

  async function claimExpired(): Promise<(Row & { checkpoint: C | null; attempts: number }) | null> {
    const { data: candidate } = await db!
      .from(table)
      .select('id, attempts, lease_until')
      .eq('status', statuses.running)
      .or(expiredFilter())
      .order(orderBy, { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!candidate) return null;
    // null — чистая передача при shutdown, не попытка. Иначе — crash/kill.
    const lost = candidate.lease_until != null;
    const attempts = (candidate.attempts ?? 0) + (lost ? 1 : 0);
    if (attempts >= maxAttempts && lost) {
      const reason = `исполнитель терял задачу ${attempts} раз(а) подряд — остановлено`;
      await db!
        .from(table)
        .update({ status: statuses.failed, attempts, ...clearOwnership, ...(opts.failedPatch?.(reason) ?? {}) })
        .eq('id', candidate.id)
        .eq('status', statuses.running)
        .or(expiredFilter())
        .select('id')
        .maybeSingle();
      log('warn', `[${table}] job ${candidate.id} failed: ${reason}`);
      return null;
    }
    const runToken = randomUUID();
    const { data } = await db!
      .from(table)
      .update({ run_token: runToken, worker_id: workerId, lease_until: leaseUntil(), attempts })
      .eq('id', candidate.id)
      .eq('status', statuses.running)
      .or(expiredFilter())
      .select(select)
      .maybeSingle();
    if (data) log('info', `[${table}] reclaimed job ${candidate.id} (${lost ? 'lease expired' : 'released'})`);
    return data ?? null;
  }

  function execute(job: Row & { checkpoint: C | null; attempts: number }): void {
    const runToken = String((job as Record<string, unknown>).run_token ?? '');
    const abort = new AbortController();
    const jobLog: JobLogger = (level, msg, extra) => log(level, `[${table}][${job.id}] ${msg}`, extra);

    const heartbeat = async () => {
      if (stopping || isShuttingDown() || abort.signal.aborted) return;
      const ok = await fencedUpdate(job.id, runToken, { lease_until: leaseUntil() });
      if (!ok && !abort.signal.aborted) {
        jobLog('warn', 'lease lost to another worker — aborting');
        abort.abort('lease-lost');
      }
    };
    const timer = setInterval(() => { void heartbeat(); }, heartbeatMs);
    if (typeof timer.unref === 'function') timer.unref();

    const ctx: JobContext<C> = {
      jobId: job.id,
      runToken,
      checkpoint: (job.checkpoint ?? null) as C | null,
      signal: abort.signal,
      shouldStop: () => stopping || abort.signal.aborted,
      log: jobLog,
      saveCheckpoint: async (data) => {
        if (abort.signal.aborted) return false;
        const patch: Record<string, unknown> = { checkpoint: data };
        if (!stopping && !isShuttingDown()) patch.lease_until = leaseUntil();
        const ok = await fencedUpdate(job.id, runToken, patch);
        if (!ok) {
          jobLog('warn', 'checkpoint rejected — job was reclaimed, aborting');
          abort.abort('lease-lost');
        }
        return ok;
      },
    };

    const promise = (async () => {
      try {
        await opts.run(job, ctx);
        if (manageTerminalStatus && !abort.signal.aborted) {
          await fencedUpdate(job.id, runToken, { status: statuses.done, ...clearOwnership });
        }
      } catch (err) {
        if (abort.signal.aborted) {
          jobLog('info', 'run interrupted (shutdown or lease lost); row left for reclaim');
          return;
        }
        const reason = err instanceof Error ? err.message : String(err);
        jobLog('error', `run failed: ${reason}`, err);
        if (!manageTerminalStatus) return;
        const attempts = (job.attempts ?? 0) + 1;
        if (attempts >= maxAttempts) {
          await fencedUpdate(job.id, runToken, {
            status: statuses.failed, attempts, ...clearOwnership, ...(opts.failedPatch?.(reason) ?? {}),
          });
        } else {
          await fencedUpdate(job.id, runToken, { status: statuses.pending, attempts, ...clearOwnership });
        }
      } finally {
        clearInterval(timer);
        if (owned.get(job.id)?.runToken === runToken) owned.delete(job.id);
      }
    })();

    owned.set(job.id, { runToken, abort, promise });
  }

  return {
    async pollOnce() {
      if (stopping) return false;
      if (owned.size >= concurrency) {
        await sleep(500);
        return true;
      }
      const job = (await claimPending()) ?? (await claimExpired());
      if (!job) return false;
      execute(job);
      return true;
    },

    async shutdown() {
      if (stopping) return;
      stopping = true;
      markShuttingDown();
      const snapshot = Array.from(owned.entries());
      for (const [, o] of snapshot) o.abort.abort('shutdown');
      const release = () =>
        Promise.all(snapshot.map(([id, o]) => fencedUpdate(id, o.runToken, { lease_until: null })));
      if (snapshot.length > 0) {
        log('info', `[${table}] releasing ${snapshot.length} job(s) for fast handoff: ${snapshot.map(([id]) => id).join(', ')}`);
        await release();
        // Второй проход: продление, улетевшее в PostgREST до сигнала, могло
        // приземлиться после первого и снова сделать аренду живой.
        await sleep(1_000);
        await release();
      }
      await Promise.race([
        Promise.allSettled(snapshot.map(([, o]) => o.promise)),
        sleep(shutdownGraceMs),
      ]);
    },

    activeJobIds: () => Array.from(owned.keys()),
  };
}
```

- [ ] **Step 2: Прогнать тест**

Run: `cd app && npx jest tests/lib/jobLifecycle.test.ts`
Expected: PASS, 8 проверок. Если падает «two replicas race»: фейк выполняет `maybeSingle` асинхронно, обе реплики читают одного кандидата, но UPDATE с `eq('status','pending')` пройдёт только у первой — вторая получит `data: null`. Если падает heartbeat-тест: убедиться, что `now` подставляется из опций, а не `Date.now`.

- [ ] **Step 3: Типы**

Run: `cd app && npm run typecheck:strict`
Expected: без ошибок. Если ругается на `any` в `DbClient` — оставить eslint-disable как в коде выше (supabase-js generic-типы для динамической таблицы не выводятся).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/jobs/lifecycle.ts app/tests/lib/jobLifecycle.test.ts
git commit -m "feat(jobs): библиотека единого жизненного цикла задач

createJobRunner: захват pending / истёкшей аренды CAS-апдейтом, продление
lease_until по таймеру, чекпойнт с ограждением по run_token, shutdown с
двойным обнулением аренды и AbortSignal для run().

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Пилот 1 — конструктор баз на библиотеке

**Files:**
- Modify: `app/worker/baseConstructor.ts` (переписать целиком)
- Modify: `app/src/app/api/tools/base-constructor/[id]/route.ts:110-149`
- Modify: `docker-compose.prod.yml:1010-1060` (anchor `worker-baseconstructor`)

Что остаётся как есть: `runBaseConstructorJob(jobId, runToken)` и его внутренние ограждения по `run_token`, продвижение `started_at` в `updateJobProgress` (монитор здоровья и самолечение в роуте читают именно его). Меняется только владение: захват, аренда, передача.

- [ ] **Step 1: Переписать воркер**

Заменить содержимое `app/worker/baseConstructor.ts` на:

```ts
/**
 * BaseConstructor worker — «Конструктор баз» в отдельном долгоживущем контейнере.
 *
 * Владение задачей — через единый жизненный цикл (lib/jobs/lifecycle.ts):
 * захват pending или задачи с истёкшей/обнулённой арендой, продление аренды по
 * таймеру, на SIGTERM — обнуление аренды, чтобы соседняя реплика подобрала job
 * на ближайшем опросе, а не через порог простоя.
 *
 * Сам runner (runBaseConstructorJob) не менялся: он по-прежнему пишет
 * терминальный статус сам, ограждает записи run_token'ом и продвигает
 * started_at как heartbeat прогресса для монитора здоровья. Поэтому
 * manageTerminalStatus=false.
 *
 * Резюм с чекпойнта живёт внутри runBaseConstructorJob (current_step /
 * current_step_progress / data), отдельный checkpoint-столбец тут не нужен.
 */

import { runBaseConstructorJob } from '@/lib/tools/baseConstructorWorker';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import {
  createWorkerLogger,
  pollLoop,
  requireSupabaseAdmin,
  setupGracefulShutdown,
} from './_shared';
import { installUndiciAssertGuard } from './_undiciAssertGuard';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
/** Сколько job'ов параллельно один воркер берёт. Память: 1 job ≈ 0.5–1.5GB JS heap. */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.BASE_CONSTRUCTOR_CONCURRENCY ?? '2'));
/**
 * Аренда. Продление идёт независимым таймером каждые lease/3, а не по тикам
 * прогресса, так что порог можно держать коротким: 5 минут = ~3 пропущенных
 * продления. Чистый redeploy аренду обнуляет сразу, порога не ждёт.
 */
const LEASE_SECONDS = Math.max(60, Number(process.env.BASE_CONSTRUCTOR_LEASE_SECONDS ?? '300'));
const WORKER_ID = `baseconstructor-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

async function main(): Promise<void> {
  log(
    'info',
    `Starting BaseConstructor worker (pid=${process.pid}, concurrency=${MAX_CONCURRENCY}, lease=${LEASE_SECONDS}s)`,
  );
  installUndiciAssertGuard(log);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const runner = createJobRunner<{ id: string }, never>({
    table: 'base_constructor_jobs',
    workerId: WORKER_ID,
    statuses: { pending: 'pending', running: 'processing', done: 'completed', failed: 'failed' },
    leaseSeconds: LEASE_SECONDS,
    concurrency: MAX_CONCURRENCY,
    manageTerminalStatus: false,
    claimPatch: () => ({ started_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason, completed_at: new Date().toISOString() }),
    log,
    run: async (job, ctx) => {
      log('info', `Running base-constructor job ${job.id}`);
      await runBaseConstructorJob(job.id, ctx.runToken);
      log('info', `Finished base-constructor job ${job.id}`);
    },
  });

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      void runner.shutdown().catch((err) => log('error', 'shutdown failed', err));
    });
  }

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce: () => runner.pollOnce(),
    realtimeTables: ['base_constructor_jobs'],
  });
  await runner.shutdown();
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
```

- [ ] **Step 2: Роут — убрать перехват задачи из HTTP**

В `app/src/app/api/tools/base-constructor/[id]/route.ts` внутри `autoCompleteIfStuck` удалить целиком блок «Случай 2» — от комментария `// Случай 2: зависло на промежуточном шаге > 15 минут — РЕСУМИМ.` до закрывающей `}` перед концом функции (строки ~110–149 в текущем файле). Функция после правки заканчивается сразу после `return;` случая 1. Заменить удалённый блок на комментарий:

```ts
  // Промежуточный шаг без живого исполнителя перехватывает сам воркер по
  // истёкшей аренде (lib/jobs/lifecycle.ts). HTTP-процесс задачи не запускает.
```

Удалить теперь неиспользуемые импорты в шапке файла:
```ts
import { randomUUID } from 'node:crypto';
import { runBaseConstructorJob } from '@/lib/tools/baseConstructorWorker';
```
Обновить docblock функции: убрать абзац про «Реальный фикс — переезд на отдельного worker'a, но пока чиним симптомами» и пункт 2 про `failed`/резюм; оставить описание случая 1.

- [ ] **Step 3: Compose**

В `docker-compose.prod.yml` в сервисе-якоре `worker-baseconstructor` (строка ~1051):
- заменить `- BASE_CONSTRUCTOR_STALE_MINUTES=${BASE_CONSTRUCTOR_STALE_MINUTES:-15}` на `- BASE_CONSTRUCTOR_LEASE_SECONDS=${BASE_CONSTRUCTOR_LEASE_SECONDS:-300}`;
- `stop_grace_period: 5m` → `stop_grace_period: 30s` (передача занимает ~2 секунды, задачу доигрывать не нужно — она продолжится с чекпойнта в другой реплике);
- в комментарии над сервисом заменить фразу «Stale (без heartbeat 15+ мин) processing-задачи любая реплика автоматически резумит» на «Задачи с истёкшей или обнулённой арендой (lease_until) любая реплика автоматически резумит с того шага, где остановились».

Проверить, что `BASE_CONSTRUCTOR_STALE_MINUTES` больше нигде не читается:
Run: `grep -rn "BASE_CONSTRUCTOR_STALE_MINUTES" --include=*.ts --include=*.yml --include=*.py --include=*.sh . | grep -v node_modules`
Expected: только комментарий в `services/health-check/main.py:1273` — заменить в нём «BASE_CONSTRUCTOR_STALE_MINUTES (15)» на «BASE_CONSTRUCTOR_LEASE_SECONDS (300 с)».

- [ ] **Step 4: Типы и связанные тесты**

Run: `cd app && npm run typecheck:strict && npx jest tests/lib/baseConstructor --silent`
Expected: typecheck чистый; тесты `baseConstructorFastHandoff`, `baseConstructorWorkerRunToken`, `baseConstructorWorkerResume` — PASS (они проверяют runner, который не менялся). `baseConstructorDeployDrain` и `baseConstructorProductionCapacity` пока падать не должны — их правим в Task 7.

- [ ] **Step 5: Commit**

```bash
git add app/worker/baseConstructor.ts "app/src/app/api/tools/base-constructor/[id]/route.ts" docker-compose.prod.yml services/health-check/main.py
git commit -m "feat(base-constructor): владение задачей через единый жизненный цикл

Воркер берёт задачи через createJobRunner (аренда lease_until вместо
порога по started_at), HTTP-роут больше не перехватывает зависшие задачи.
stop_grace_period 5m → 30s: передача занимает секунды.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Пилот 2 — TG-парсер: прерывание и продолжение с чекпойнта

**Files:**
- Modify: `app/src/lib/tgParser/types.ts:34-56` (`ParseOptions`)
- Modify: `app/src/lib/tgParser/parser.ts:304-310, 496-620`
- Modify: `app/src/lib/tgParser/tgParserJobWorker.ts:216-260, 395-460`

Чекпойнт: `{ done_links: string[], users: ParsedUser[] }`, пишется после каждого обработанного источника. На продолжении из списка ссылок выбрасываются уже сделанные, а набранные пользователи подсаживаются в накопитель (иначе сломаются дедуп и лимит контактов).

- [ ] **Step 1: `types.ts` — расширить `ParseOptions`**

Добавить в `ParseOptions` после `onProgress`:

```ts
  /**
   * Останов по сигналу (деплой, потеря аренды). Проверяется между источниками и
   * раз в 30 секунд внутри этапа: обход прерывается, собранное возвращается со
   * stop_reason='interrupted', задача продолжится с чекпойнта у другого исполнителя.
   */
  signal?: AbortSignal;
  /** Пользователи, набранные до перезапуска (из чекпойнта): подсаживаются в накопитель. */
  initialUsers?: ParsedUser[];
  /** Источник полностью обработан (или окончательно пропущен) — момент для чекпойнта. */
  onLinkDone?: (link: string, usersSoFar: ParsedUser[]) => void | Promise<void>;
```

- [ ] **Step 2: `parser.ts` — прерывание, посев, колбэк**

Строка 304: `export type ParseStopReason = 'contact_limit' | 'error' | 'interrupted';`

В `parseTgUsers` после `const allUsers = new Map<number, ParsedUser>();` добавить:
```ts
  for (const u of opts.initialUsers ?? []) allUsers.set(u.ID, u);
```

В начале тела цикла `for (const link of opts.links)` — первой строкой:
```ts
      if (opts.signal?.aborted) { stopRef.reason = 'interrupted'; break; }
```

В `runStage`, внутри `setInterval` сторожа, перед проверкой простоя добавить:
```ts
            if (opts.signal?.aborted) {
              stopRef.reason = 'interrupted';
              reject(new Error('interrupted'));
              return;
            }
```
и в `catch (e)` `runStage` — первой проверкой:
```ts
          if (msg === 'interrupted') return;
```
(до существующей `if (!msg.includes('нет движения')) throw e;`).

После внешнего `try { … } catch (e) { … linkFailures.push … }` внутри цикла по ссылкам (то есть после обработки одного источника, успешной или нет) добавить:
```ts
      if (!stopRef.reason && opts.onLinkDone) {
        try {
          await opts.onLinkDone(trimmed, [...allUsers.values()]);
        } catch {
          // Чекпойнт — страховка, а не результат: его сбой не должен ронять сбор.
        }
      }
```

Возврат: существующая ветка `if (stopRef.reason) return { status: 'partial', users, stop_reason: stopRef.reason };` уже отдаёт `'interrupted'` — менять не нужно.

- [ ] **Step 3: `tgParserJobWorker.ts` — контекст, чекпойнт, продолжение**

Экспортировать тип и расширить сигнатуру:

```ts
export type TgParserCheckpoint = { done_links: string[]; users: ParsedUser[] };

export interface TgParserRunContext {
  signal: AbortSignal;
  checkpoint: TgParserCheckpoint | null;
  saveCheckpoint(data: TgParserCheckpoint): Promise<boolean>;
}

export async function runTgParserJob(jobId: string, ctx?: TgParserRunContext): Promise<void> {
```

После `const { links } = normalizeTgLinks(cfg.links);` добавить:
```ts
  const checkpoint = ctx?.checkpoint ?? null;
  const doneLinks = new Set(checkpoint?.done_links ?? []);
  const remainingLinks = links.filter((l) => !doneLinks.has(l));
  const seedUsers = checkpoint?.users ?? [];
  if (checkpoint) {
    await writeJobLog({
      jobId, jobUserId, isTarget, accountLabel, level: 'info',
      message: `Продолжаем после перезапуска: источников готово ${doneLinks.size} из ${links.length}, контактов набрано ${seedUsers.length}`,
    });
  }
```

В вызове `parseTgUsers({...})` заменить `links,` на `links: remainingLinks,` и добавить три поля:
```ts
      signal: ctx?.signal,
      initialUsers: seedUsers,
      onLinkDone: async (link, usersSoFar) => {
        doneLinks.add(link);
        await ctx?.saveCheckpoint({ done_links: [...doneLinks], users: sanitizeUsersForJson(usersSoFar) });
      },
```

Все источники уже обработаны на прошлом запуске (упали ровно между последним чекпойнтом и записью итога): `parseTgUsers` вернул бы «links is empty». Обернуть вызов:
```ts
    const result: ParseResult = remainingLinks.length === 0 && checkpoint
      ? { status: 'ok', users: seedUsers }
      : await parseTgUsers({ … });
```
(импортировать `type ParseResult` из `@/lib/tgParser/parser`).

Сразу после получения `result`, до `const safeUsers = …`:
```ts
    if (result.status === 'partial' && result.stop_reason === 'interrupted') {
      await writeJobLog({
        jobId, jobUserId, isTarget, accountLabel, level: 'info',
        message: 'Остановлено для перезапуска исполнителя — продолжится с чекпойнта',
      });
      await trace?.end({ stage: 'parse', status: 'interrupted', users_count: result.users.length });
      return; // статус остаётся running, аренду отпустит библиотека
    }
```

- [ ] **Step 4: Типы**

Run: `cd app && npm run typecheck:strict`
Expected: чисто. Частая ошибка: `ParseResult` не экспортируется из индекса — импортировать именно из `@/lib/tgParser/parser`.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tgParser/types.ts app/src/lib/tgParser/parser.ts app/src/lib/tgParser/tgParserJobWorker.ts
git commit -m "feat(tg-parser): прерывание по сигналу и продолжение с чекпойнта

parseTgUsers: signal/initialUsers/onLinkDone; задача сохраняет
{done_links, users} после каждого источника и при перезапуске исполнителя
продолжает с него, а не с нуля.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Пилот 2 — воркер TG-парсера на библиотеке

**Files:**
- Modify: `app/worker/tgParser.ts` (переписать целиком)
- Modify: `docker-compose.prod.yml:893-921` (`worker-tg-parser`)

- [ ] **Step 1: Переписать воркер**

```ts
/**
 * TG User Parser worker. Владение задачей — единый жизненный цикл
 * (lib/jobs/lifecycle.ts): аренда, чекпойнт {done_links, users}, передача при
 * остановке. Сброса running→pending при старте больше нет: брошенную задачу
 * определяет истёкшая аренда, и берёт её тот, кто первым опросил.
 *
 * Терминальный статус (done/error) пишет сам runTgParserJob — он умеет
 * облегчать payload при ошибке записи. Поэтому manageTerminalStatus=false;
 * библиотека переводит задачу в error только если исполнитель терял её три
 * раза подряд (crash/OOM), чтобы битая задача не крутилась вечно.
 */

import { runTgParserJob, type TgParserCheckpoint } from '@/lib/tgParser/tgParserJobWorker';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
/** Обход одного источника идёт минуты; продление каждые 60 с при аренде 3 мин. */
const LEASE_SECONDS = Math.max(60, Number(process.env.TG_PARSER_LEASE_SECONDS ?? '180'));
const WORKER_ID = `tg-parser-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

async function main(): Promise<void> {
  log('info', `Starting TG User Parser worker (pid=${process.pid}, lease=${LEASE_SECONDS}s)`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const runner = createJobRunner<{ id: string }, TgParserCheckpoint>({
    table: 'tg_parser_jobs',
    workerId: WORKER_ID,
    statuses: { pending: 'pending', running: 'running', done: 'done', failed: 'error' },
    leaseSeconds: LEASE_SECONDS,
    concurrency: 1,
    manageTerminalStatus: false,
    claimPatch: () => ({ started_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason, completed_at: new Date().toISOString() }),
    log,
    run: async (job, ctx) => {
      log('info', `Running TG parser job ${job.id}${ctx.checkpoint ? ' (RESUME)' : ''}`);
      await runTgParserJob(job.id, {
        signal: ctx.signal,
        checkpoint: ctx.checkpoint,
        saveCheckpoint: ctx.saveCheckpoint,
      });
    },
  });

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      void runner.shutdown().catch((err) => log('error', 'shutdown failed', err));
    });
  }

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce: () => runner.pollOnce(),
    realtimeTables: ['tg_parser_jobs'],
  });
  await runner.shutdown();
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
```

- [ ] **Step 2: Compose**

В `docker-compose.prod.yml`, сервис `worker-tg-parser`: `stop_grace_period: 30m` → `stop_grace_period: 30s`.

- [ ] **Step 3: Типы и сборка воркеров**

Run: `cd app && npm run typecheck:strict && npm run build:workers 2>&1 | tail -3`
Expected: typecheck чистый; esbuild отдаёт `dist/workers/tgParser.js` и `dist/workers/baseConstructor.js` без ошибок (это тот же бандл, что уходит в образ `portal-worker`).

- [ ] **Step 4: Commit**

```bash
git add app/worker/tgParser.ts docker-compose.prod.yml
git commit -m "feat(tg-parser): воркер на едином жизненном цикле задач

Захват через аренду вместо сброса running→pending при старте, чекпойнт
передаётся в runTgParserJob. stop_grace_period 30m → 30s.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Деплой без списков контейнеров; тесты старого механизма

**Files:**
- Modify: `drain-worker.sh`
- Modify: `.semaphore/scheduled-deploy.yml:498-502`
- Delete: `app/tests/lib/baseConstructorDeployDrain.test.ts`
- Modify: `app/tests/lib/baseConstructorProductionCapacity.test.ts:83-95`
- Modify: `app/tests/lib/engHiringWorkerIsolation.test.ts:48-60`
- Modify: `app/tests/lib/autoPipelineDeployDrain.test.ts:14-60`

- [ ] **Step 1: `drain-worker.sh`**

1. В шапке заменить пункты 3–4 комментария на:
```bash
# 3) Воркеры, переведённые на единый жизненный цикл задач
#    (lib/jobs/lifecycle.ts), сюда НЕ входят: их таблицы не правим, контейнеры
#    останавливает деплой через `docker compose stop --timeout 15`, а задачи
#    воркеры передают сами через аренду. Переведены: base_constructor_jobs,
#    tg_parser_jobs. По мере перевода остальных этот скрипт худеет до нуля.
```
2. Из массива `tracked_tables=(…)` удалить строку `"tg_parser_jobs"`.
3. Удалить блок остановки generic-контейнеров целиком — от `if should_drain_non_baseconstructor_workers; then` с `containers=(` до его `fi` (строки ~303–322).
4. Удалить комментарий про инцидент 11.08.2026 и весь блок `if should_drain_baseconstructor_workers; then … fi` с `bc_containers` и `patch_rows "base_constructor_jobs"` (строки ~324–372).
5. Последний `echo` заменить на: `echo "[drain] Legacy job tables paused; container stop is done by the deploy step"`.

Функции `is_baseconstructor_worker`, `should_drain_baseconstructor_workers` становятся неиспользуемыми — удалить их; `should_drain_non_baseconstructor_workers` остаётся (гейтит правку таблиц).

Run: `bash -n drain-worker.sh`
Expected: без вывода (синтаксис цел).

- [ ] **Step 2: `scheduled-deploy.yml`, шаг 5**

Заменить
```
                  echo \"--- Step 5: restart selected workers: \${WORKER_TARGETS} ---\";
                  for svc in \${WORKER_TARGETS}; do force_rm_svc \"\$svc\"; done;
```
на
```
                  echo \"--- Step 5: restart selected workers: \${WORKER_TARGETS} ---\";
                  # SIGTERM всем выбранным воркерам разом; 15 с хватает: воркеры на едином
                  # жизненном цикле отпускают аренду за ~2 с, задачу доигрывать не нужно.
                  # force_rm_svc ниже — запасной ход для тех, кто не остановился.
                  sudo -n env DOCKER_GID=\"\${DOCKER_GID}\" docker compose --env-file .env -p portal -f docker-compose.prod.yml stop --timeout 15 \${WORKER_TARGETS} || true;
                  for svc in \${WORKER_TARGETS}; do force_rm_svc \"\$svc\"; done;
```
(экранирование `\"` и `\$` — как в соседних строках файла: это тело sshpass-heredoc).

Run: `npx --yes yaml-lint .semaphore/scheduled-deploy.yml 2>/dev/null || node -e "require('js-yaml').load(require('fs').readFileSync('.semaphore/scheduled-deploy.yml','utf8'));console.log('yaml ok')"`
Expected: `yaml ok` (js-yaml есть в `app/node_modules`; при необходимости запускать из `app/`).

- [ ] **Step 3: Тесты старого механизма**

- Удалить `app/tests/lib/baseConstructorDeployDrain.test.ts` (все три `it` фиксировали bash-списки и backdate `started_at`).
- В `baseConstructorProductionCapacity.test.ts` удалить `it('includes every replica in the parallel deploy drain', …)` целиком.
- В `engHiringWorkerIsolation.test.ts`, тест `deploys ENG hiring through its own prod compose service`: удалить строку `const drainWorker = readRepoFile('drain-worker.sh');` и `expect(drainWorker).toContain('portal-worker-eng-hiring');`.
- В `autoPipelineDeployDrain.test.ts` удалить: блок `genericContainerBlock` (три строки: match, `toBeDefined`, `not.toContain('portal-worker-autopipeline')`), и пару `genericStopIndex` (`const genericStopIndex = …` и `expect(genericStopIndex).toBeGreaterThan(autoStopIndex)`). Оставить проверки graceful stop и порядка `drain-worker.sh` → `force_rm_svc` в деплое (они по-прежнему верны).

Run: `cd app && npx jest tests/lib/baseConstructor tests/lib/engHiring tests/lib/autoPipelineDeployDrain --silent`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git rm app/tests/lib/baseConstructorDeployDrain.test.ts
git add drain-worker.sh .semaphore/scheduled-deploy.yml app/tests/lib/baseConstructorProductionCapacity.test.ts app/tests/lib/engHiringWorkerIsolation.test.ts app/tests/lib/autoPipelineDeployDrain.test.ts
git commit -m "feat(deploy): compose stop вместо списков контейнеров в drain-worker.sh

Шаг 5 деплоя шлёт SIGTERM всем выбранным воркерам через
docker compose stop --timeout 15; drain-worker.sh больше не хранит имена
контейнеров и не правит base_constructor_jobs / tg_parser_jobs — эти
воркеры передают задачи сами. Тесты старого механизма сняты.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Полная проверка и push

- [ ] **Step 1: Весь набор тестов с замером**

Run: `cd app && npx jest --silent 2>&1 | tail -8`
Expected: все файлы PASS, число файлов = 176 (было 176, +1 новый, −1 удалённый), общее время < 3 минут. Если `jobLifecycle.test.ts` тянет больше секунды — где-то реальная пауза вместо виртуальной (проверить `sleep(500)` в `pollOnce`: в тестах его не должно быть, потому что `pollOnce` при заполненном `concurrency` не зовём).

- [ ] **Step 2: Типы и линт**

Run: `cd app && npm run typecheck:strict && npx eslint src/lib/jobs/lifecycle.ts worker/baseConstructor.ts worker/tgParser.ts src/lib/tgParser/parser.ts src/lib/tgParser/tgParserJobWorker.ts "src/app/api/tools/base-constructor/[id]/route.ts"`
Expected: без ошибок.

- [ ] **Step 3: Чужие правки в дереве**

Run: `git status --porcelain`
Expected: пусто (все правки закоммичены; если есть чужие незакоммиченные файлы — не трогать, сообщить пользователю).

- [ ] **Step 4: Push**

```bash
git push origin dmitriy_kuladmed
```

Затем отчитаться: ветка, SHA последнего коммита, итоги `jest` (файлов/проверок/время) и `typecheck`. Мерж и деплой делает пользователь.

---

## Что проверить на бою после деплоя (для пользователя, не для агента)

1. `docker logs portal-worker-tg-parser --tail 50` — строка `Starting TG User Parser worker (… lease=180s)`.
2. Запустить TG-парсинг на 2–3 чата, во время обхода `docker restart portal-worker-tg-parser`. В журнале задачи ожидаются строки «Остановлено для перезапуска исполнителя» и затем «Продолжаем после перезапуска: источников готово N из M».
3. Конструктор баз: на следующем деплое задача в «В работе» должна перескочить на другую реплику за секунды (в логах — `releasing 1 job(s) for fast handoff` у старого контейнера и `reclaimed job … (released)` у нового).
4. Через сутки — `select count(*) from base_constructor_jobs where status='processing' and lease_until < now() - interval '10 minutes'` должно быть 0.
