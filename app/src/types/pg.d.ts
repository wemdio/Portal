// Minimal ambient types for `node-postgres` (pg). The package ships no types
// and @types/pg isn't a dependency. We declare only the surface used by the
// Portal dataset clients and guarded import scripts.
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
    query_timeout?: number;
    application_name?: string;
    ssl?: boolean | Record<string, unknown>;
  }

  export interface PoolClient {
    query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
    release(err?: Error | boolean): void;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
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
