/** @jest-environment node */

import { Writable } from 'node:stream';

import * as copyClientModule from '@/lib/companiesDirectory/fnsExactPgCopyClient';

const createFnsExactPgClient = (
  copyClientModule as unknown as {
    createFnsExactPgClient: (
      client: {
        query(
          query: unknown,
          values?: unknown[],
        ): unknown;
      },
      copyFactory: (sql: string) => Writable & { rowCount: number },
    ) => {
      query(
        sql: string,
        values?: unknown[],
      ): Promise<{
        rows: Array<Record<string, unknown>>;
        rowCount: number | null;
      }>;
      copyFrom(
        sql: string,
        rows: AsyncIterable<string>,
      ): Promise<number>;
    };
  }
).createFnsExactPgClient;

describe('FNS exact PostgreSQL COPY client', () => {
  it('binds normal queries and pipelines async rows with backpressure', async () => {
    let copiedPayload = '';
    const copyStream = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        copiedPayload += chunk.toString();
        setImmediate(callback);
      },
    }) as Writable & { rowCount: number };
    copyStream.rowCount = 2;

    const nativeQuery = jest.fn((
      query: unknown,
      _values?: unknown[],
    ) => {
      if (typeof query === 'string') {
        return Promise.resolve({
          rows: [{ ok: true }],
          rowCount: 1,
        });
      }
      expect(query).toBe(copyStream);
      return copyStream;
    });
    const copyFactory = jest.fn((_sql: string) => copyStream);
    const client = createFnsExactPgClient(
      { query: nativeQuery },
      copyFactory,
    );

    await expect(client.query('SELECT $1', [7])).resolves.toEqual({
      rows: [{ ok: true }],
      rowCount: 1,
    });

    async function* rows(): AsyncIterable<string> {
      yield '"1","7700000000"\n';
      yield '"2","7800000000"\n';
    }

    await expect(client.copyFrom(
      'COPY stage FROM STDIN',
      rows(),
    )).resolves.toBe(2);

    expect(nativeQuery).toHaveBeenNthCalledWith(1, 'SELECT $1', [7]);
    expect(copyFactory).toHaveBeenCalledWith('COPY stage FROM STDIN');
    expect(copiedPayload).toBe(
      '"1","7700000000"\n"2","7800000000"\n',
    );
  });
});
