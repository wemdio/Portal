/**
 * Lightweight in-memory mock for Supabase client (`from(table).select/insert/...`).
 *
 * Why exists: production code uses thin wrappers around `supabase-js` chaining
 * (`db.from('x').select(...).eq(...).gte(...).maybeSingle()`). Mocking these
 * by hand in every test produces a lot of duplication, so we extract the
 * shared shape here.
 *
 * The mock is intentionally minimal — it implements only the subset of the
 * supabase-js surface our codebase actually relies on. Extend as needed; do
 * NOT chase 1:1 parity with @supabase/supabase-js. Each new operator should
 * come with a unit test in the consuming spec.
 *
 * Filtering semantics:
 *   - eq/neq/in/gte/lte/lt/gt run on the in-memory rows in the order they were
 *     called (mirrors how PostgREST stacks predicates).
 *   - .or('and(eq.x,eq.y),and(eq.a,eq.b)') is parsed as a disjunction of AND
 *     groups whose terms are simple `column.op.value` expressions. Other
 *     operators (`is`, `like`, ...) are not yet supported here on purpose.
 *   - .not('col', 'is', null) and .not('col', 'in', '(a,b,c)') are supported.
 *
 * Mutations:
 *   - insert(rows) appends to the table and records the call (per-table and
 *     globally). Returns the inserted rows on `.select()` chaining.
 *   - upsert(rows, { onConflict }) replaces matching rows by the comma-
 *     separated `onConflict` keys; if no match — inserts.
 *   - update(patch).eq(...) patches matching rows.
 *   - delete().eq(...) removes only matching rows and returns them.
 *
 * Awaiting a builder: every chain is thenable, so `await db.from('t').select()`
 * returns `{ data, error: null }`. Use `.maybeSingle()` / `.single()` for the
 * single-row variants.
 */

export type Row = Record<string, unknown>;

export interface MockSupabaseSeed {
  /** Initial rows per table. */
  tables?: Record<string, Row[]>;
  /**
   * Таблицы, чьи запросы возвращают {data: null, error: {message}} —
   * supabase-js НЕ бросает исключений, и коду приходится проверять error
   * явно. Нужно для пинов деградационных веток (блип БД).
   */
  errorTables?: Record<string, string>;
  /**
   * Прицельная инъекция ошибки: только SELECT'ы данной таблицы, чья проекция
   * содержит подстроку columnsInclude. Позволяет уронить один конкретный
   * запрос (напр. projects.lead_criteria), не задевая другие запросы к той же
   * таблице (напр. верификацию привязки projects.select('id, client')).
   */
  errorSelects?: Record<string, { columnsInclude: string; message: string }>;
}

export interface InsertCall {
  table: string;
  rows: Row[];
}

export interface UpsertCall {
  table: string;
  rows: Row[];
  onConflict: string | null;
}

export interface UpdateCall {
  table: string;
  patch: Row;
  filters: Filter[];
}

export interface SelectCall {
  table: string;
  /** Raw projection string passed to .select() ('*' when omitted). */
  columns: string;
}

export type MutationCall =
  | { kind: 'insert'; table: string; rows: Row[] }
  | { kind: 'upsert'; table: string; rows: Row[]; onConflict: string | null }
  | { kind: 'update'; table: string; patch: Row; filters: Filter[] }
  | { kind: 'delete'; table: string; rows: Row[] };

export interface MockSupabaseClient {
  from: (table: string) => Builder;

  /** Snapshot of all rows currently stored (after inserts/updates). */
  getRows: (table: string) => Row[];

  /** Recorded inserts in chronological order. */
  inserts: InsertCall[];
  /** Recorded upserts in chronological order. */
  upserts: UpsertCall[];
  /** Recorded updates in chronological order. */
  updates: UpdateCall[];
  /** All mutations in their actual execution order across tables. */
  mutations: MutationCall[];
  /**
   * Recorded .select() projections in chronological order. Lets tests pin
   * WHICH columns a query asked for — e.g. «the ownership check must not
   * de-TOAST the data blob» (see clientLaunchesRoute.test.ts).
   */
  selects: SelectCall[];
}

type Op = 'eq' | 'neq' | 'in' | 'gte' | 'lte' | 'gt' | 'lt' | 'is' | 'not_is' | 'not_in';

interface Filter {
  column: string;
  op: Op;
  value: unknown;
}

interface Builder {
  select: (columns?: string, opts?: { count?: 'exact' | 'planned' | 'estimated' }) => Builder;
  insert: (rows: Row | Row[]) => Builder;
  upsert: (rows: Row | Row[], opts?: { onConflict?: string }) => Builder;
  update: (patch: Row) => Builder;
  delete: () => Builder;

  eq: (column: string, value: unknown) => Builder;
  neq: (column: string, value: unknown) => Builder;
  in: (column: string, values: unknown[]) => Builder;
  gte: (column: string, value: unknown) => Builder;
  lte: (column: string, value: unknown) => Builder;
  gt: (column: string, value: unknown) => Builder;
  lt: (column: string, value: unknown) => Builder;
  is: (column: string, value: unknown) => Builder;
  not: (column: string, op: string, value: unknown) => Builder;
  or: (expr: string) => Builder;

  order: (...args: unknown[]) => Builder;
  limit: (...args: unknown[]) => Builder;
  range: (...args: unknown[]) => Promise<{ data: Row[]; error: null; count: number }>;

  single: () => Promise<{ data: Row | null; error: { message: string; code?: string } | null }>;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;

  then: <T>(
    onFulfilled?: (value: { data: Row[]; error: null; count: number }) => T,
    onRejected?: (reason: unknown) => T,
  ) => Promise<T>;
}

function applyFilter(rows: Row[], f: Filter): Row[] {
  switch (f.op) {
    case 'eq':
      return rows.filter((r) => r[f.column] === f.value);
    case 'neq':
      return rows.filter((r) => r[f.column] !== f.value);
    case 'in':
      return rows.filter((r) => Array.isArray(f.value) && (f.value as unknown[]).includes(r[f.column]));
    case 'gte':
      return rows.filter((r) => (r[f.column] as never) >= (f.value as never));
    case 'lte':
      return rows.filter((r) => (r[f.column] as never) <= (f.value as never));
    case 'gt':
      return rows.filter((r) => (r[f.column] as never) > (f.value as never));
    case 'lt':
      return rows.filter((r) => (r[f.column] as never) < (f.value as never));
    case 'is':
      return rows.filter((r) => r[f.column] === f.value);
    case 'not_is':
      return rows.filter((r) => r[f.column] !== f.value);
    case 'not_in': {
      const list = parseInList(f.value);
      return rows.filter((r) => !list.includes(String(r[f.column])));
    }
  }
}

function parseInList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string') return [];
  // PostgREST format: '("a","b")' or '(a,b)'.
  const inner = raw.replace(/^\(|\)$/g, '');
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/**
 * Parse a PostgREST `.or()` expression: a comma-separated list of either
 *  - simple terms `col.op.value`
 *  - `and(col.op.value,col.op.value,...)` AND-groups
 *
 * Returns disjunction of conjunctions. Nested `or()` is not supported.
 */
function parseOrExpr(expr: string): Filter[][] {
  const groups: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      groups.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf) groups.push(buf);

  return groups.map((g) => {
    const trimmed = g.trim();
    if (trimmed.startsWith('and(') && trimmed.endsWith(')')) {
      const body = trimmed.slice(4, -1);
      return body
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .map(parseTerm);
    }
    return [parseTerm(trimmed)];
  });
}

function parseTerm(term: string): Filter {
  const [column, op, ...rest] = term.split('.');
  const valueRaw = rest.join('.');
  const value = valueRaw === 'null' ? null : valueRaw;
  const opMap: Record<string, Op> = {
    eq: 'eq', neq: 'neq', gte: 'gte', lte: 'lte', gt: 'gt', lt: 'lt', is: 'is',
  };
  return { column, op: opMap[op] ?? 'eq', value };
}

export function createMockSupabase(seed: MockSupabaseSeed = {}): MockSupabaseClient {
  // Deep-clone seed so test mutations don't leak across cases.
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed.tables ?? {})) {
    tables[t] = rows.map((r) => ({ ...r }));
  }

  const inserts: InsertCall[] = [];
  const upserts: UpsertCall[] = [];
  const updates: UpdateCall[] = [];
  const mutations: MutationCall[] = [];
  const selects: SelectCall[] = [];
  let generatedIdSeq = 1;

  function withGeneratedId(table: string, row: Row): Row {
    if (Object.prototype.hasOwnProperty.call(row, 'id')) return row;
    return { ...row, id: `mock-${table}-${generatedIdSeq++}` };
  }

  function makeBuilder(table: string): Builder {
    let errorMessage = seed.errorTables?.[table];
    const selectError = seed.errorSelects?.[table];
    const filters: Filter[] = [];
    const orGroups: Filter[][][] = []; // list of (DNF) constraints; each must hold
    let mode: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
    let pendingInsert: Row[] = [];
    let pendingUpsert: { rows: Row[]; onConflict: string | null } | null = null;
    let pendingUpdate: Row | null = null;

    function rowsForRead(): Row[] {
      let out = tables[table] ? tables[table].slice() : [];
      for (const f of filters) out = applyFilter(out, f);
      for (const groupSet of orGroups) {
        out = out.filter((r) =>
          groupSet.some((conj) => conj.every((f) => applyFilter([r], f).length > 0)),
        );
      }
      return out;
    }

    function flushMutation(): { data: Row[]; error: null; count: number } {
      if (mode === 'insert') {
        const insertedRows = pendingInsert.map((row) => withGeneratedId(table, row));
        tables[table] = (tables[table] ?? []).concat(insertedRows);
        inserts.push({ table, rows: insertedRows });
        mutations.push({ kind: 'insert', table, rows: insertedRows });
        return { data: insertedRows, error: null, count: insertedRows.length };
      }
      if (mode === 'upsert' && pendingUpsert) {
        const keyCols = (pendingUpsert.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const existing = tables[table] ?? [];
        const result: Row[] = existing.slice();
        const returnedRows: Row[] = [];
        for (const r of pendingUpsert.rows) {
          let replaced = false;
          for (let i = 0; i < result.length; i++) {
            if (keyCols.length && keyCols.every((k) => result[i][k] === r[k])) {
              const nextRow = { ...result[i], ...r };
              result[i] = nextRow;
              returnedRows.push(nextRow);
              replaced = true;
              break;
            }
          }
          if (!replaced) {
            const nextRow = withGeneratedId(table, r);
            result.push(nextRow);
            returnedRows.push(nextRow);
          }
        }
        tables[table] = result;
        upserts.push({ table, rows: pendingUpsert.rows, onConflict: pendingUpsert.onConflict });
        mutations.push({
          kind: 'upsert',
          table,
          rows: pendingUpsert.rows,
          onConflict: pendingUpsert.onConflict,
        });
        return { data: returnedRows, error: null, count: returnedRows.length };
      }
      if (mode === 'update' && pendingUpdate) {
        const matching = rowsForRead();
        const matched = new Set(matching);
        const next = (tables[table] ?? []).map((r) =>
          matched.has(r) ? { ...r, ...pendingUpdate } : r,
        );
        tables[table] = next;
        updates.push({ table, patch: pendingUpdate, filters: filters.slice() });
        mutations.push({ kind: 'update', table, patch: pendingUpdate, filters: filters.slice() });
        return { data: matching, error: null, count: matching.length };
      }
      if (mode === 'delete') {
        const matching = rowsForRead();
        const matched = new Set(matching);
        tables[table] = (tables[table] ?? []).filter((row) => !matched.has(row));
        mutations.push({ kind: 'delete', table, rows: matching });
        return { data: matching, error: null, count: matching.length };
      }
      const data = rowsForRead();
      return { data, error: null, count: data.length };
    }

    const builder: Builder = {
      select: (columns) => {
        selects.push({ table, columns: columns ?? '*' });
        if (selectError && (columns ?? '*').includes(selectError.columnsInclude)) {
          errorMessage = selectError.message;
        }
        return builder;
      },
      insert: (rows) => {
        mode = 'insert';
        pendingInsert = Array.isArray(rows) ? rows.slice() : [rows];
        return builder;
      },
      upsert: (rows, opts) => {
        mode = 'upsert';
        pendingUpsert = {
          rows: Array.isArray(rows) ? rows.slice() : [rows],
          onConflict: opts?.onConflict ?? null,
        };
        return builder;
      },
      update: (patch) => {
        mode = 'update';
        pendingUpdate = patch;
        return builder;
      },
      delete: () => {
        mode = 'delete';
        return builder;
      },

      eq: (column, value) => { filters.push({ column, op: 'eq', value }); return builder; },
      neq: (column, value) => { filters.push({ column, op: 'neq', value }); return builder; },
      in: (column, values) => { filters.push({ column, op: 'in', value: values }); return builder; },
      gte: (column, value) => { filters.push({ column, op: 'gte', value }); return builder; },
      lte: (column, value) => { filters.push({ column, op: 'lte', value }); return builder; },
      gt: (column, value) => { filters.push({ column, op: 'gt', value }); return builder; },
      lt: (column, value) => { filters.push({ column, op: 'lt', value }); return builder; },
      is: (column, value) => { filters.push({ column, op: 'is', value }); return builder; },

      not: (column, op, value) => {
        if (op === 'is') filters.push({ column, op: 'not_is', value });
        else if (op === 'in') filters.push({ column, op: 'not_in', value });
        else throw new Error(`mockSupabase: not.${op} is not implemented`);
        return builder;
      },

      or: (expr) => {
        orGroups.push(parseOrExpr(expr));
        return builder;
      },

      order: () => builder,
      limit: () => builder,
      range: async () => flushMutation(),

      single: async () => {
        if (errorMessage) return { data: null, error: { message: errorMessage } };
        const result = flushMutation();
        const first = result.data[0] ?? null;
        // Как у настоящего PostgREST: 0 строк на .single() → PGRST116.
        return { data: first, error: first ? null : { message: 'not found', code: 'PGRST116' } };
      },
      maybeSingle: async () => {
        if (errorMessage) return { data: null, error: { message: errorMessage } as never };
        const result = flushMutation();
        return { data: result.data[0] ?? null, error: null };
      },

      then: <T>(onFulfilled?: (v: { data: Row[]; error: null; count: number }) => T) =>
        errorMessage
          ? Promise.resolve({ data: null as never, error: { message: errorMessage } as never, count: 0 }).then(onFulfilled as never)
          : Promise.resolve(flushMutation()).then(onFulfilled as never),
    };

    return builder;
  }

  return {
    from: makeBuilder,
    getRows: (table: string) => (tables[table] ?? []).map((r) => ({ ...r })),
    inserts,
    upserts,
    updates,
    mutations,
    selects,
  };
}
