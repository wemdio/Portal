/**
 * Shared in-memory mock for the LinkedIn-outreach campaign-runner tests.
 *
 * Why a *separate* helper from `mockSupabase.ts`:
 *   - The campaign runner uses `.select('*, lead:li_leads(*)')` (a join syntax
 *     the generic mock doesn't parse). The convention in liOutreach tests is
 *     to seed `lead: <row>` directly into each `li_campaign_leads` row, so we
 *     need a builder that returns rows verbatim.
 *   - Tests want to inspect the exact `update` payloads (e.g. `cooldown_until`,
 *     `invites_sent_today`) — recorded as `dbState.updates` here.
 *   - We need RPC support (`db.rpc('li_campaign_increment_invite', { ... })`)
 *     with caller-defined handlers so we can simulate the atomic SQL function
 *     in JS and assert that the runner uses it instead of the old
 *     read-modify-write pattern.
 *
 * Keep this helper minimal — extend operators only when the runner adds new
 * predicates that real tests need. Do NOT chase 1:1 supabase-js parity.
 */

export type Row = Record<string, unknown>;

export type RpcHandler = (args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { message: string } | null;
}>;

export interface DbState {
  rows: Record<string, Row[]>;
  updates: Array<{ table: string; data: Row; filters: Record<string, unknown> }>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
}

export interface MockDb {
  state: DbState;
  reset: () => void;
  registerRpc: (name: string, handler: RpcHandler) => void;
  client: {
    from: (table: string) => unknown;
    rpc: (name: string, args?: Record<string, unknown>) => Promise<{
      data: unknown;
      error: { message: string } | null;
    }>;
  };
  /** Convenience accessors for assertions. */
  updatesFor: (table: string) => Array<{ data: Row; filters: Record<string, unknown> }>;
  rpcCallsFor: (name: string) => Array<{ args: Record<string, unknown> }>;
}

export function createLiOutreachMockDb(): MockDb {
  const state: DbState = { rows: {}, updates: [], rpcCalls: [] };
  const rpcHandlers = new Map<string, RpcHandler>();

  function makeBuilder(table: string): Record<string, unknown> {
    const filters: Record<string, unknown> = {};
    let inserted: Row | Row[] | null = null;
    let updated: Row | null = null;
    let mode: 'select' | 'update' | 'insert' | 'delete' = 'select';

    const finalize = (): { data: Row[]; error: null } => {
      let rows = (state.rows[table] ?? []).slice();
      for (const [col, val] of Object.entries(filters)) {
        if (col === '__or' || col === '__in_status') continue;
        rows = rows.filter((r) => r[col] === val);
      }
      if (filters.__in_status) {
        const allowed = filters.__in_status as string[];
        rows = rows.filter((r) => allowed.includes(String(r.status ?? '')));
      }
      return { data: rows, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => {
        mode = 'select';
        return builder;
      },
      insert: (data: Row | Row[]) => {
        mode = 'insert';
        inserted = data;
        return builder;
      },
      update: (data: Row) => {
        mode = 'update';
        updated = data;
        return builder;
      },
      delete: () => {
        mode = 'delete';
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      in: (col: string, values: unknown[]) => {
        if (col === 'status') filters.__in_status = values as string[];
        else filters[col] = values;
        return builder;
      },
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      single: async () => {
        const r = finalize();
        return { data: r.data[0] ?? null, error: r.data[0] ? null : { message: 'not found' } };
      },
      maybeSingle: async () => {
        const r = finalize();
        return { data: r.data[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => void) => {
        if (mode === 'update') {
          state.updates.push({ table, data: updated ?? {}, filters: { ...filters } });
          const r = finalize();
          for (const row of r.data) {
            Object.assign(row, updated ?? {});
          }
          resolve({ data: null, error: null });
          return;
        }
        if (mode === 'insert') {
          const arr = Array.isArray(inserted) ? inserted : [inserted as Row];
          state.rows[table] = (state.rows[table] ?? []).concat(arr);
          resolve({ data: arr, error: null });
          return;
        }
        resolve(finalize());
      },
    };

    return builder;
  }

  return {
    state,
    reset: (): void => {
      state.rows = {};
      state.updates = [];
      state.rpcCalls = [];
    },
    registerRpc: (name, handler): void => {
      rpcHandlers.set(name, handler);
    },
    client: {
      from: makeBuilder,
      rpc: async (name, args = {}) => {
        state.rpcCalls.push({ fn: name, args: { ...args } });
        const handler = rpcHandlers.get(name);
        if (!handler) {
          return { data: null, error: { message: `mock: no RPC handler registered for ${name}` } };
        }
        return handler(args);
      },
    },
    updatesFor: (table) => state.updates.filter((u) => u.table === table),
    rpcCallsFor: (name) => state.rpcCalls.filter((c) => c.fn === name).map(({ args }) => ({ args })),
  };
}
