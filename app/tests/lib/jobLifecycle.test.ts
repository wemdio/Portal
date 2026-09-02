/**
 * @jest-environment node
 *
 * Контракты единого жизненного цикла задач (lib/jobs/lifecycle.ts):
 *  - две реплики берут одну pending-задачу — побеждает одна;
 *  - истёкшая или обнулённая аренда перехватывается, живая — нет;
 *  - продление и чекпойнт с чужим run_token не проходят;
 *  - shutdown обнуляет аренду только своих задач и глушит продления;
 *  - исключение в run ниже maxAttempts → pending, на пределе → failed;
 *  - where отсекает чужой тип задачи на обоих путях захвата;
 *  - терминальный статус, записанный телом, снимает владение со строки, а
 *    оставленная в running строка остаётся нетронутой.
 *
 * Время — виртуальное: аренда и таймеры прокручиваются, а не проживаются.
 */

import { __resetShutdownStateForTests } from '@/lib/workerShutdown';
import { createJobRunner, type JobContext } from '@/lib/jobs/lifecycle';

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'neq' | 'lt' | 'in' | 'or'; col?: string; value?: unknown; raw?: string };

const T0 = Date.parse('2026-09-02T10:00:00.000Z');
let clock = T0;
const now = () => clock;

/** Крошечный PostgREST: строки в памяти, фильтры eq/lt/or(is.null,lt). */
function makeFakeDb(initial: Row[]) {
  const rows: Row[] = initial.map((r) => ({ ...r }));
  const updates: Array<{ patch: Row; matched: number; filters: Filter[] }> = [];
  /**
   * Переключатели поведения базы:
   *  - failUpdates — отвечает ошибкой на запись (см. тест про сбой захвата);
   *  - hangUpdates — не отвечает вовсе (у undici нет таймаута по умолчанию,
   *    это главный сценарий обрыва связи);
   *  - updateDelayMs — отвечает, но медленно.
   */
  const control = { failUpdates: false, hangUpdates: false, updateDelayMs: 0 };

  const matches = (row: Row, filters: Filter[]) =>
    filters.every((f) => {
      if (f.op === 'eq') return row[f.col!] === f.value;
      if (f.op === 'neq') return row[f.col!] !== f.value;
      if (f.op === 'in') return (f.value as unknown[]).includes(row[f.col!]);
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
    q.neq = (col: string, value: unknown) => { filters.push({ op: 'neq', col, value }); return q; };
    q.in = (col: string, value: unknown[]) => { filters.push({ op: 'in', col, value }); return q; };
    q.lt = (col: string, value: unknown) => { filters.push({ op: 'lt', col, value }); return q; };
    q.or = (raw: string) => { filters.push({ op: 'or', raw }); return q; };
    q.order = (col: string) => { orderCol = col; return q; };
    q.limit = (n: number) => { limit = n; return q; };
    q.maybeSingle = async () => {
      let hit = rows.filter((r) => matches(r, filters));
      if (orderCol) hit = [...hit].sort((a, b) => String(a[orderCol!]).localeCompare(String(b[orderCol!])));
      hit = hit.slice(0, limit);
      if (mode === 'update') {
        if (control.hangUpdates) await new Promise<never>(() => {});
        if (control.updateDelayMs > 0) {
          await new Promise<void>((resolve) => { setTimeout(resolve, control.updateDelayMs); });
          // Пересчитываем совпадения после паузы: за время запроса строку мог
          // забрать сосед.
          hit = rows.filter((r) => matches(r, filters)).slice(0, limit);
        }
        if (control.failUpdates) return { data: null, error: { message: 'statement timeout' } };
        for (const r of hit) Object.assign(r, patch);
        updates.push({ patch, matched: hit.length, filters: [...filters] });
      }
      return { data: hit[0] ? { ...hit[0] } : null, error: null };
    };
    return q;
  };

  return { client: { from } as never, rows, updates, control };
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

    const polls = Promise.all([runA.pollOnce(), runB.pollOnce()]);
    // Проигравший перед ответом выжидает паузу — прокручиваем её.
    await jest.advanceTimersByTimeAsync(1_000);
    const [gotA, gotB] = await polls;
    await flush();

    // Оба просят позвать снова: победитель — потому что взял задачу,
    // проигравший — потому что кандидат был и очередь могла не опустеть
    // (иначе он уснул бы до 30 с на ожидании realtime). Тело при этом
    // запущено ровно одно — это и есть «победитель один».
    expect([gotA, gotB]).toEqual([true, true]);
    expect(runs).toHaveLength(1);
    expect(db.rows[0].status).toBe('running');
    expect(typeof db.rows[0].run_token).toBe('string');
    expect(db.rows[0].lease_until).toBe(new Date(T0 + 60_000).toISOString());
  });

  it('a failed claim update is not a lost race — no immediate re-poll', async () => {
    const db = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    const run = jest.fn(async () => {});
    const runner = makeRunner(db, run);
    // База отвечает ошибкой на запись: кандидат виден, захват не проходит.
    db.control.failUpdates = true;

    // false, а не true: ноль строк из-за сбоя ничего не говорит об очереди, и
    // pollLoop зовёт снова без паузы — иначе реплики уходят в цикл по базе,
    // которой и так плохо.
    expect(await runner.pollOnce()).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(db.rows[0].status).toBe('pending');
    expect(db.rows[0].run_token).toBeUndefined();
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
    const runner = makeRunner(db, run, { failedPatch: (reason: string) => ({ error_message: reason }) });

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

  it('reports an unpersisted checkpoint while still answering "owned"', async () => {
    const db = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    const unpersisted: string[] = [];
    let ctxRef: JobContext<Row> | null = null;
    const runner = makeRunner(db, async (_job, ctx) => { ctxRef = ctx; await new Promise(() => {}); }, {
      onCheckpointUnpersisted: (jobId: string) => { unpersisted.push(jobId); },
    });
    await runner.pollOnce();
    await flush();

    // База не принимает запись (в жизни — слишком большой чекпойнт).
    db.control.failUpdates = true;
    const saving = ctxRef!.saveCheckpoint({ page: 3 });
    await jest.advanceTimersByTimeAsync(2_000); // повторы записи
    // true — про ВЛАДЕНИЕ: строка всё ещё наша, работу прекращать не надо.
    expect(await saving).toBe(true);
    // Но воркер обязан узнать, что продолжение с места мертво.
    expect(unpersisted).toEqual(['j']);
    expect(db.rows[0].checkpoint).toBeUndefined();
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

  it('a stalled progress column stops renewals and abandons the lease', async () => {
    const db = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 2, processed: 0 }]);
    let ctxRef: JobContext<Row> | null = null;
    const runner = makeRunner(db, async (_job, ctx) => {
      ctxRef = ctx;
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
    }, { progress: { column: 'processed', stalledAfterMs: 45_000 } });
    await runner.pollOnce();
    await flush();

    // Прогресс сдвинулся: аренда продлена, бюджет попыток возвращён.
    db.rows[0].processed = 7;
    clock += 20_000; jest.setSystemTime(clock);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(db.rows[0].lease_until).toBe(new Date(clock + 60_000).toISOString());
    expect(db.rows[0].attempts).toBe(0);

    // Прогресс встал. Порог 45 с ещё не выбран — продление идёт.
    clock += 20_000; jest.setSystemTime(clock);
    await jest.advanceTimersByTimeAsync(20_000);
    const lastLease = db.rows[0].lease_until;
    expect(lastLease).toBe(new Date(clock + 60_000).toISOString());

    // Порог перейден: продления прекращаются, run прерывается.
    clock += 30_000; jest.setSystemTime(clock);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(ctxRef!.signal.aborted).toBe(true);
    // Аренду НЕ обнуляем: она истекает сама, сосед подбирает задачу и
    // засчитывает потерю как падение — ровно как старый порог по started_at.
    expect(db.rows[0].lease_until).toBe(lastLease);

    // Дальше таймер молчит: аренда больше не продлевается.
    clock += 60_000; jest.setSystemTime(clock);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(db.rows[0].lease_until).toBe(lastLease);
  });

  it('shutdown during an in-flight claim releases the job instead of starting it', async () => {
    const db = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    const run = jest.fn(async () => {});
    const runner = makeRunner(db, run, { shutdownGraceMs: 3_000 });

    // Сигнал приходит, пока запрос захвата в полёте: снимок owned в shutdown
    // уже снят, и задачу, захваченную следом, некому прервать и отпустить.
    const polling = runner.pollOnce();
    const stopping = runner.shutdown();
    const claimed = await polling;
    await jest.advanceTimersByTimeAsync(5_000);
    await stopping;

    expect(claimed).toBe(false);
    expect(run).not.toHaveBeenCalled();
    // Чистая передача: аренда обнулена, попытка не потрачена.
    expect(db.rows[0].lease_until).toBeNull();
    expect(db.rows[0].attempts).toBe(0);
    expect(runner.activeJobIds()).toEqual([]);
  });

  it('a thrown run goes back to pending below maxAttempts and to failed at the limit', async () => {
    const db = makeFakeDb([
      { id: 'a', status: 'pending', created_at: '1', attempts: 0 },
      { id: 'b', status: 'pending', created_at: '2', attempts: 2 },
    ]);
    const runner = makeRunner(db, async () => { throw new Error('boom'); }, {
      concurrency: 2,
      failedPatch: (reason: string) => ({ error_message: reason }),
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

  it('the where filter keeps a worker off another type on the pending path', async () => {
    // Одна таблица на несколько типов парсеров: чужая задача стоит ПЕРВОЙ по
    // порядку захвата, так что взять свою можно только фильтром, а не сортировкой.
    const db = makeFakeDb([
      { id: 'eng', status: 'pending', created_at: '1', attempts: 0, parser_type: 'eng_hiring' },
      { id: 'hh', status: 'pending', created_at: '2', attempts: 0, parser_type: 'hh_vacancies' },
    ]);
    const seen: string[] = [];
    const runner = makeRunner(db, async (job) => { seen.push(job.id as string); }, {
      where: [['parser_type', ['hh_vacancies', 'ats_companies']]],
    });

    expect(await runner.pollOnce()).toBe(true);
    await flush();

    expect(seen).toEqual(['hh']);
    expect(db.rows.find((r) => r.id === 'eng')!.status).toBe('pending');
    expect(db.rows.find((r) => r.id === 'eng')!.run_token).toBeUndefined();
    // Фильтр обязан стоять и в CAS-UPDATE, а не только в выборе кандидата:
    // между двумя запросами тип строки может смениться, и без него воркер
    // в гонке уводит чужую задачу.
    const claim = db.updates.find((u) => u.patch.status === 'running')!;
    expect(claim.filters).toContainEqual({ op: 'in', col: 'parser_type', value: ['hh_vacancies', 'ats_companies'] });
  });

  it('the where filter keeps a worker off another type when reclaiming an expired lease', async () => {
    const db = makeFakeDb([
      { id: 'eng', status: 'running', created_at: '1', attempts: 0, parser_type: 'eng_hiring', run_token: 'e', lease_until: new Date(T0 - 1_000).toISOString() },
      { id: 'hh', status: 'running', created_at: '2', attempts: 0, parser_type: 'hh_vacancies', run_token: 'h', lease_until: new Date(T0 - 1_000).toISOString() },
    ]);
    const seen: string[] = [];
    const runner = makeRunner(db, async (job) => { seen.push(job.id as string); }, {
      where: [['parser_type', 'hh_vacancies']],
    });

    expect(await runner.pollOnce()).toBe(true);
    await flush();

    expect(seen).toEqual(['hh']);
    // Чужую строку не тронули: ни жетон, ни счётчик попыток.
    expect(db.rows.find((r) => r.id === 'eng')!.run_token).toBe('e');
    expect(db.rows.find((r) => r.id === 'eng')!.attempts).toBe(0);
    const reclaim = db.updates.find((u) => u.patch.worker_id === 'w1')!;
    expect(reclaim.filters).toContainEqual({ op: 'eq', col: 'parser_type', value: 'hh_vacancies' });
  });

  it('releases ownership when run() itself wrote the terminal status', async () => {
    // manageTerminalStatus=false: раньше библиотека не писала ничего, и
    // завершённая (или отменённая пользователем) задача навсегда оставалась
    // с живыми lease_until/run_token/worker_id — дежурный запрос по арендам
    // показывал давно закрытые строки.
    const db = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    const runner = makeRunner(db, async () => { db.rows[0].status = 'cancelled'; }, { manageTerminalStatus: false });
    await runner.pollOnce();
    await flush();

    expect(db.rows[0].status).toBe('cancelled');
    expect(db.rows[0].lease_until).toBeNull();
    expect(db.rows[0].run_token).toBeNull();
    expect(db.rows[0].worker_id).toBeNull();
  });

  it('aborts a job whose lease provably expired, even while the renewal hangs', async () => {
    // Часовой обрыв связи с базой на многочасовой кампании. Продление уходит в
    // PostgREST и не возвращается никогда (у undici нет таймаута по умолчанию),
    // поэтому свежие тики встают на том же await и до кода продления не доходят.
    // Уберечь от «сосед уже работает, а мы ещё держим сессии» может только
    // проверка по часам, и стоять она обязана ДО guard'а от наложения.
    const db = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    let ctxRef: JobContext<Row> | null = null;
    const runner = makeRunner(db, async (_job, ctx) => {
      ctxRef = ctx;
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
    });
    await runner.pollOnce();
    await flush();
    const leaseAtClaim = db.rows[0].lease_until;
    db.control.hangUpdates = true;

    // Аренда 60 с, продление каждые 20 с. На 20/40/60 секундах прерывать рано:
    // на 60-й аренда истекает ровно, а не «провисела дольше срока».
    for (const t of [20_000, 40_000, 60_000]) {
      clock = T0 + t; jest.setSystemTime(clock);
      await jest.advanceTimersByTimeAsync(20_000);
      expect(ctxRef!.signal.aborted).toBe(false);
    }
    // 80 секунд — это 4/3 аренды: первый тик, на котором она заведомо истекла.
    clock = T0 + 80_000; jest.setSystemTime(clock);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(ctxRef!.signal.aborted).toBe(true);
    expect(ctxRef!.signal.reason).toBe('lease-expired');
    // Аренду не обнуляем: строка уже могла уйти соседу, и трогать её нечем.
    expect(db.rows[0].lease_until).toBe(leaseAtClaim);
  });

  it('counts the lease from the renewal request, not from its reply', async () => {
    // База отвечает, но медленно — тридцать секунд на запись. lease_until в ней
    // посчитан от момента ДО запроса, значит и наша самопроверка обязана
    // считать от него: иначе мы верим в аренду, которой в базе уже нет, ровно
    // на длительность запроса — а длинные запросы бывают именно у больной базы.
    const db = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    let ctxRef: JobContext<Row> | null = null;
    const runner = makeRunner(db, async (_job, ctx) => {
      ctxRef = ctx;
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
    });
    await runner.pollOnce();
    await flush();
    const at = async (t: number) => {
      const delta = T0 + t - clock;
      clock = T0 + t; jest.setSystemTime(clock);
      await jest.advanceTimersByTimeAsync(delta);
    };

    db.control.updateDelayMs = 30_000;
    await at(20_000); // тик 20 с: продление ушло, ответа ещё нет
    await at(50_000); // ответ пришёл на 50-й секунде
    expect(db.rows[0].lease_until).toBe(new Date(T0 + 80_000).toISOString());

    // Дальше база отвечает ошибкой: продлений больше нет.
    db.control.updateDelayMs = 0;
    db.control.failUpdates = true;
    await at(80_000); // 80 − 20 = 60 с ровно, ещё не «дольше срока»
    expect(ctxRef!.signal.aborted).toBe(false);
    // 100 с: с точкой отсчёта по ОТВЕТУ (50 с) здесь ещё «всё хорошо», и
    // пересечение с соседом длилось бы на полминуты дольше.
    await at(100_000);
    expect(ctxRef!.signal.aborted).toBe(true);
  });

  it('beforeRelease closes external resources while the lease is still ours', async () => {
    // Ради этого хук и заведён: TG-аутрич держит живые MTProto-сессии, и сосед,
    // подхвативший строку раньше, чем клиенты закрыты, выключает аккаунты
    // навсегда. Тело здесь БРОСАЕТ на отмене — это путь, на котором оно само
    // торопится отпустить аренду и без пропуска обгоняет хук.
    const db = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    let leaseWhileClosing: unknown = 'хук не позвали';
    let closedIds: string[] = [];
    const runner = makeRunner(db, async (_job, ctx) => {
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }, {
      shutdownGraceMs: 6_000,
      beforeRelease: async (ids: string[]) => {
        closedIds = ids;
        await new Promise<void>((resolve) => { setTimeout(resolve, 1_000); });
        leaseWhileClosing = db.rows[0].lease_until;
      },
    });
    await runner.pollOnce();
    await flush();

    const done = runner.shutdown();
    await jest.advanceTimersByTimeAsync(10_000);
    await done;

    expect(closedIds).toEqual(['j']);
    expect(leaseWhileClosing).toBe(new Date(T0 + 60_000).toISOString());
    expect(db.rows[0].lease_until).toBeNull();
  });

  it('a beforeRelease that hangs or throws still lets the lease go', async () => {
    // Неотпущенная аренда хуже отпущенной на несколько секунд позже: задачу с
    // живой арендой не подберёт никто до конца leaseSeconds, а перехват потом
    // запишет это как падение и потратит попытку.
    const body = async (_job: Row, ctx: JobContext<Row>) => {
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
    };
    const hanging = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    const hangingRunner = makeRunner(hanging, body, {
      shutdownGraceMs: 5_000,
      beforeReleaseTimeoutMs: 2_000,
      beforeRelease: () => new Promise(() => {}),
    });
    const throwing = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    const throwingRunner = makeRunner(throwing, body, {
      shutdownGraceMs: 5_000,
      beforeRelease: () => { throw new Error('gramJS disconnect failed'); },
    });
    await hangingRunner.pollOnce();
    await throwingRunner.pollOnce();
    await flush();

    const done = Promise.all([hangingRunner.shutdown(), throwingRunner.shutdown()]);
    await jest.advanceTimersByTimeAsync(15_000);
    await done;

    expect(hanging.rows[0].lease_until).toBeNull();
    expect(throwing.rows[0].lease_until).toBeNull();
  });

  it('does not release ownership from a row the body deliberately left running', async () => {
    // Тело вернулось штатно, но статус оставило running — задачу продолжит
    // другая реплика с чекпойнта. Ей нужны живые жетон и аренда.
    const db = makeFakeDb([{ id: 'j', status: 'pending', created_at: '1', attempts: 0 }]);
    const runner = makeRunner(db, async () => {}, { manageTerminalStatus: false });
    await runner.pollOnce();
    await flush();

    expect(db.rows[0].status).toBe('running');
    expect(typeof db.rows[0].run_token).toBe('string');
    expect(db.rows[0].worker_id).toBe('w1');
    expect(db.rows[0].lease_until).toBe(new Date(T0 + 60_000).toISOString());
  });
});
