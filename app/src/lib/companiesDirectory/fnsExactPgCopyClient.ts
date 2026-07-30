import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  from as postgresCopyFrom,
  type CopyStreamQuery,
} from 'pg-copy-streams';

import type {
  FnsExactPgClient,
  FnsExactPgQueryResult,
} from '@/lib/companiesDirectory/fnsExactPostgresApply';

export interface FnsExactNativePgClient {
  query(query: unknown, values?: unknown[]): unknown;
}

export type FnsExactCopyStreamFactory = (
  sql: string,
) => Writable & { rowCount: number };

const defaultCopyStreamFactory: FnsExactCopyStreamFactory = (
  sql,
) => postgresCopyFrom(sql) as CopyStreamQuery;

export function createFnsExactPgClient(
  client: FnsExactNativePgClient,
  copyStreamFactory: FnsExactCopyStreamFactory =
    defaultCopyStreamFactory,
): FnsExactPgClient {
  return {
    query: async (
      sql: string,
      values?: unknown[],
    ): Promise<FnsExactPgQueryResult> => {
      return await client.query(sql, values) as FnsExactPgQueryResult;
    },
    copyFrom: async (
      sql: string,
      rows: AsyncIterable<string>,
    ): Promise<number> => {
      const copyStream = copyStreamFactory(sql);
      client.query(copyStream);
      await pipeline(
        Readable.from(rows, { objectMode: false }),
        copyStream,
      );
      if (
        !Number.isSafeInteger(copyStream.rowCount)
        || copyStream.rowCount < 0
      ) {
        throw new Error(
          `PostgreSQL COPY returned an invalid row count: `
          + `${String(copyStream.rowCount)}`,
        );
      }
      return copyStream.rowCount;
    },
  };
}
