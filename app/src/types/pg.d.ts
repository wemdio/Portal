// Minimal ambient types for `node-postgres` (pg). The package ships no types
// and @types/pg isn't a dependency (pg is used only by app/scripts/* in plain
// JS). We declare just the surface used by src/lib/instantlyDataset.ts.
declare module 'pg' {
  export interface QueryResult<R = Record<string, unknown>> {
    rows: R[];
    rowCount: number;
  }

  export interface PoolConfig {
    connectionString?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    statement_timeout?: number;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
    on(event: 'error', listener: (err: Error) => void): this;
    end(): Promise<void>;
  }

  export class Client {
    constructor(config?: PoolConfig);
    connect(): Promise<void>;
    query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
}
