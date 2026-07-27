/** @jest-environment node */

import type { PoolClient } from 'pg';

const mockDatasetQuery = jest.fn();
const mockDatasetConnect = jest.fn();
const mockDatasetExportConnect = jest.fn();

jest.mock('@/lib/twoGisDataset', () => ({
  twoGisDatasetQuery: (...args: unknown[]) => mockDatasetQuery(...args),
  twoGisDatasetConnect: (...args: unknown[]) => mockDatasetConnect(...args),
  twoGisDatasetExportConnect: (...args: unknown[]) => mockDatasetExportConnect(...args),
}));

import {
  createTwoGisExportTicket,
  getTwoGisExportTicket,
  iterateTwoGisCards,
} from '@/lib/twoGis/repository';
import { TWO_GIS_IMPORT_LOCK } from '@/lib/twoGis/importSnapshot';

const CARD = {
  id: '4504127908669251',
  name: 'Кафе',
  city_name: 'Москва',
  geometry_name: 'улица 1',
  post_code: '',
  phone: '+74950000000',
  email: '',
  website: '',
  vkontakte: '',
  instagram: '',
  lon: '37.61',
  lat: '55.75',
  category: 'Еда',
  subcategory: 'Кафе',
};

function createTicketClient(rowCount: number) {
  return {
    query: jest.fn(async (sql: string) => {
      if (/count\(\*\)/i.test(sql)) {
        return { rows: [{ count: String(rowCount) }] };
      }
      if (/from public\.dataset_snapshots/i.test(sql)) {
        return { rows: [{ id: '42' }] };
      }
      if (/insert into public\.export_tickets/i.test(sql)) {
        return { rows: [{ token_hash: 'stored' }] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDatasetQuery.mockResolvedValue([{ token_hash: 'stored' }]);
});

describe('2GIS repository export boundary', () => {
  it('counts and binds the ticket to one snapshot under the same shared lock', async () => {
    const client = createTicketClient(10);
    mockDatasetConnect.mockResolvedValue(client);

    const prepared = await createTwoGisExportTicket(
      'staff-1',
      { cities: ['Москва'] },
    );

    expect(prepared).toEqual({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      rowCount: 10,
    });
    expect(client.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock_shared(hashtext($1))',
      [TWO_GIS_IMPORT_LOCK],
    );
    const insertCall = client.query.mock.calls.find(([sql]) =>
      /insert into public\.export_tickets/i.test(sql),
    );
    expect(insertCall?.[0]).toMatch(/delete from public\.export_tickets/i);
    expect(insertCall?.[0]).not.toMatch(/select id[\s\S]*dataset_snapshots/i);
    expect(insertCall?.[1]?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(insertCall?.[1]?.[2]).toBe(42);
    expect(insertCall?.[1]?.[4]).toBe(10);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('does not create a ticket when the current snapshot has no matching rows', async () => {
    const client = createTicketClient(0);
    mockDatasetConnect.mockResolvedValue(client);

    await expect(
      createTwoGisExportTicket('staff-1', {}),
    ).resolves.toBeNull();
    expect(client.query.mock.calls.some(([sql]) =>
      /insert into public\.export_tickets/i.test(sql),
    )).toBe(false);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('allows an export of exactly 500,000 rows', async () => {
    const client = createTicketClient(500_000);
    mockDatasetConnect.mockResolvedValue(client);

    await expect(
      createTwoGisExportTicket('staff-1', {}),
    ).resolves.toEqual({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      rowCount: 500_000,
    });
    expect(client.query.mock.calls.some(([sql]) =>
      /insert into public\.export_tickets/i.test(sql),
    )).toBe(true);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('does not create a ticket when more than 500,000 rows match', async () => {
    const client = createTicketClient(500_001);
    mockDatasetConnect.mockResolvedValue(client);

    await expect(
      createTwoGisExportTicket('staff-1', {}),
    ).resolves.toEqual({
      limited: true,
      rowCount: 500_001,
      maxRows: 500_000,
    });
    expect(client.query.mock.calls.some(([sql]) =>
      /insert into public\.export_tickets/i.test(sql),
    )).toBe(false);
    expect(client.query.mock.calls.some(([sql]) =>
      /from public\.dataset_snapshots/i.test(sql),
    )).toBe(false);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back and releases the connection when ticket preparation fails', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (/count\(\*\)/i.test(sql)) throw new Error('count failed');
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    mockDatasetConnect.mockResolvedValue(client);

    await expect(
      createTwoGisExportTicket('staff-1', {}),
    ).rejects.toThrow('count failed');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('atomically consumes a valid ticket so the URL cannot be replayed', async () => {
    mockDatasetQuery.mockResolvedValueOnce([
      { filters: { cities: ['Москва'] }, row_count: '10', snapshot_id: '42' },
    ]);

    await expect(getTwoGisExportTicket('a'.repeat(43))).resolves.toEqual({
      filters: { cities: ['Москва'] },
      rowCount: 10,
      snapshotId: 42,
    });
    expect(mockDatasetQuery.mock.calls[0][0]).toMatch(
      /delete from public\.export_tickets[\s\S]*expires_at > now\(\)[\s\S]*returning/i,
    );
  });

  it('holds a shared snapshot lock across every keyset batch and releases it', async () => {
    let selects = 0;
    const client = {
      query: jest.fn(async (sql: string) => {
        if (/from public\.dataset_snapshots/i.test(sql)) {
          return { rows: [{ id: '42' }] };
        }
        if (/select .* from public\.cards/i.test(sql)) {
          selects += 1;
          return { rows: selects === 1 ? [CARD] : [] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const batches: unknown[] = [];
    for await (const batch of iterateTwoGisCards(
      { cities: ['Москва'] },
      {
        batchSize: 1,
        snapshotId: 42,
        client: client as unknown as PoolClient,
      },
    )) {
      batches.push(batch);
    }

    expect(batches).toEqual([[CARD]]);
    expect(client.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_lock_shared(hashtext($1))',
      [TWO_GIS_IMPORT_LOCK],
    );
    expect(client.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock_shared(hashtext($1))',
      [TWO_GIS_IMPORT_LOCK],
    );
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(mockDatasetExportConnect).not.toHaveBeenCalled();
  });

  it('refuses to mix rows when a ticket belongs to an older snapshot', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (/from public\.dataset_snapshots/i.test(sql)) {
          return { rows: [{ id: '43' }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    mockDatasetExportConnect.mockResolvedValue(client);

    const iterator = iterateTwoGisCards(
      { cities: ['Москва'] },
      { batchSize: 1, snapshotId: 42 },
    );
    await expect(iterator.next()).rejects.toThrow(/snapshot changed/i);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
