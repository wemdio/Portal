/** @jest-environment node */

/**
 * Постраничный список задач парсера.
 *
 * Раньше роут тянул полсотни задач разом и рисовал их одним полотном. Со
 * страницей по десять появились две вещи, которые ломаются молча: смещение
 * (не то окно — и оператор смотрит на чужие задачи, не замечая этого) и
 * отдельная выдача идущих задач. Второе важно: по ней живут опрос списка и
 * подсказка «этот аккаунт уже парсит», а обе — про всю очередь, а не про то,
 * что попало на текущую страницу.
 */

type RpcCall = { name: string; args: Record<string, unknown> };

const rpcCalls: RpcCall[] = [];
let rpcResult: { data: unknown; error: unknown } = { data: [], error: null };
let runningRows: unknown[] = [];
let fallbackRows: { data: unknown[]; count: number } = { data: [], count: 0 };
let rangeCall: { from: number; to: number } | null = null;

function makeSupabase() {
  const runningBuilder = {
    select: () => runningBuilder,
    in: () => runningBuilder,
    order: () => runningBuilder,
    limit: () => Promise.resolve({ data: runningRows, error: null }),
    range: (from: number, to: number) => {
      rangeCall = { from, to };
      return Promise.resolve({ data: fallbackRows.data, error: null, count: fallbackRows.count });
    },
  };

  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcResult;
    },
    from: () => runningBuilder,
  };
}

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: () => 'token',
  createAuthedSupabaseClient: () => makeSupabase(),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_o: unknown, h: () => Promise<unknown>) => h(),
}));

import { GET } from '@/app/api/tools/tg-parser/jobs/route';

const req = (url: string) => ({
  headers: { get: () => 'Bearer token' },
  nextUrl: new URL(url),
} as never);

const job = (id: string, total: number) => ({ id, status: 'done', total_count: total });

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResult = { data: [], error: null };
  runningRows = [];
  fallbackRows = { data: [], count: 0 };
  rangeCall = null;
});

describe('GET /tg-parser/jobs', () => {
  it('передаёт лимит и смещение страницы в RPC', async () => {
    rpcResult = { data: [job('a', 37)], error: null };

    await GET(req('http://x/api/tools/tg-parser/jobs?limit=10&offset=20'));

    expect(rpcCalls[0]).toEqual({
      name: 'tg_parser_jobs_list',
      args: { row_limit: 10, row_offset: 20 },
    });
  });

  it('общее число берёт из оконного счётчика, а не из длины страницы', async () => {
    rpcResult = { data: [job('a', 37), job('b', 37)], error: null };

    const res = await GET(req('http://x/api?limit=10&offset=0'));
    const body = await res.json() as { items: unknown[]; total: number };

    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(37);
  });

  it('страница за концом списка — пусто и ноль, а не ошибка', async () => {
    rpcResult = { data: [], error: null };

    const res = await GET(req('http://x/api?limit=10&offset=999'));
    const body = await res.json() as { items: unknown[]; total: number };

    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('идущие задачи отдаются отдельно от страницы', async () => {
    rpcResult = { data: [job('a', 12)], error: null };
    runningRows = [{ id: 'r1', status: 'running' }, { id: 'r2', status: 'pending' }];

    const res = await GET(req('http://x/api?limit=10&offset=0'));
    const body = await res.json() as { running: unknown[] };

    expect(body.running).toHaveLength(2);
  });

  it('мусорное смещение не уводит выборку в минус', async () => {
    rpcResult = { data: [], error: null };

    await GET(req('http://x/api?limit=10&offset=-5'));
    expect(rpcCalls[0].args.row_offset).toBe(0);

    rpcCalls.length = 0;
    await GET(req('http://x/api?limit=10&offset=abc'));
    expect(rpcCalls[0].args.row_offset).toBe(0);
  });

  it('лимит зажат сверху: страницей нельзя вытянуть всю таблицу', async () => {
    rpcResult = { data: [], error: null };

    await GET(req('http://x/api?limit=99999&offset=0'));
    expect(rpcCalls[0].args.row_limit).toBe(100);
  });

  /** Пока миграция не применена, RPC с новым аргументом не найдётся. */
  it('без нового RPC откатывается на прямой select с тем же окном', async () => {
    rpcResult = { data: null, error: { message: 'function not found' } };
    fallbackRows = { data: [{ id: 'a' }], count: 42 };

    const res = await GET(req('http://x/api?limit=10&offset=20'));
    const body = await res.json() as { items: unknown[]; total: number };

    expect(rangeCall).toEqual({ from: 20, to: 29 });
    expect(body.total).toBe(42);
    expect(body.items).toHaveLength(1);
  });
});
