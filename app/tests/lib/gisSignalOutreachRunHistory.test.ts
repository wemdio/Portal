/** @jest-environment node */

jest.mock('server-only', () => ({}));

type Row = Record<string, unknown>;

// Минимальный thenable-чейн PostgREST: getRunHistory ждёт {data,error} в
// конце select→eq/like→order→limit — остальное не нужно.
function makeChain(getRows: () => Row[]) {
  const c: Record<string, unknown> = {
    select: () => c,
    eq: () => c,
    like: () => c,
    order: () => c,
    limit: () => c,
  };
  Object.defineProperty(c, 'then', {
    value: (resolve: unknown, reject: unknown) =>
      Promise.resolve({ data: getRows(), error: null }).then(resolve as never, reject as never),
  });
  return c;
}

jest.mock('@/lib/supabaseAdmin', () => {
  const tables: Record<string, Row[]> = {};
  return {
    supabaseAdmin: {
      from: (table: string) => makeChain(() => tables[table] ?? []),
      __setRows: (table: string, rows: Row[]) => {
        tables[table] = rows;
      },
    },
  };
});

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getRunHistory } from '@/lib/gisSignalOutreach/reportQueries';

const admin = supabaseAdmin as unknown as {
  __setRows: (table: string, rows: Row[]) => void;
};

function runRow(over: Partial<Row>): Row {
  return { id: 'run-id', started_at: '', finished_at: null, status: 'completed', funnel: null, error: null, ...over };
}

function jobRow(over: Partial<Row>): Row {
  return { id: 'job-id', status: 'completed', created_at: '', error_message: null, ...over };
}

beforeEach(() => {
  admin.__setRows('gis_signal_runs', []);
  admin.__setRows('base_constructor_jobs', []);
});

describe('getRunHistory — связка прогона с базой', () => {
  it('матчит базу по окну прогона и не отдаёт одну базу двум прогонам', async () => {
    admin.__setRows('gis_signal_runs', [
      runRow({ id: 'r2', started_at: '2026-09-13T00:30:00Z', finished_at: '2026-09-13T05:00:00Z' }),
      runRow({ id: 'r1', started_at: '2026-09-12T00:30:00Z', finished_at: '2026-09-12T05:00:00Z' }),
    ]);
    admin.__setRows('base_constructor_jobs', [
      jobRow({ id: 'b2', created_at: '2026-09-13T03:00:00Z' }),
      jobRow({ id: 'b1', created_at: '2026-09-12T03:00:00Z' }),
    ]);

    const runs = await getRunHistory('user-1');
    expect(runs.map((r) => [r.id, r.base?.id])).toEqual([
      ['r2', 'b2'],
      ['r1', 'b1'],
    ]);
  });

  it('чужой job клиента (вне окна прогона) базой прогона не становится', async () => {
    // Клиент собрал свою базу днём — между ночными прогонами.
    admin.__setRows('gis_signal_runs', [
      runRow({ id: 'r1', started_at: '2026-09-13T00:30:00Z', finished_at: '2026-09-13T05:00:00Z' }),
    ]);
    admin.__setRows('base_constructor_jobs', [
      jobRow({ id: 'own', created_at: '2026-09-13T14:00:00Z' }),
    ]);

    const [run] = await getRunHistory('user-1');
    expect(run.base).toBeNull();
  });

  it('идущему прогону (finished_at нет) база матчится в пределах 12 часов', async () => {
    admin.__setRows('gis_signal_runs', [
      runRow({ id: 'r1', started_at: '2026-09-13T00:30:00Z', finished_at: null, status: 'running' }),
    ]);
    admin.__setRows('base_constructor_jobs', [
      jobRow({ id: 'b1', created_at: '2026-09-13T03:10:00Z', status: 'processing' }),
    ]);

    const [run] = await getRunHistory('user-1');
    expect(run.status).toBe('running');
    expect(run.base?.id).toBe('b1');
    expect(run.base?.status).toBe('processing');
  });
});

describe('getRunHistory — итоги и ошибки прогона', () => {
  it('без funnel.total суммирует perSegment, onlineOk падает на signalsOk', async () => {
    admin.__setRows('gis_signal_runs', [
      runRow({
        funnel: {
          perSegment: {
            edu: { pulled: 40, signalsOk: 10, bcIn: 8, validContacts: 5, appended: 5 },
            legal: { pulled: 60, signalsOk: 20, onlineOk: 15, bcIn: 12, validContacts: 9, appended: 7 },
          },
        },
      }),
    ]);

    const [run] = await getRunHistory('user-1');
    expect(run.totals).toEqual({
      pulled: 100, signalsOk: 30, onlineOk: 25, bcIn: 20, validContacts: 14, appended: 12,
    });
  });

  it('неизвестный статус → failed, причина обрезается до 500 символов', async () => {
    admin.__setRows('gis_signal_runs', [
      runRow({
        id: 'r1',
        started_at: '2026-09-13T00:30:00Z',
        status: 'killed',
        error: 'x'.repeat(600),
      }),
    ]);

    const [run] = await getRunHistory('user-1');
    expect(run.status).toBe('failed');
    expect(run.error?.length).toBe(500);
  });
});
