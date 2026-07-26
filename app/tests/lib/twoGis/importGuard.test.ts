/** @jest-environment node */

import {
  assertTwoGisDatasetTarget,
  assertTwoGisImportTarget,
} from '@/lib/twoGis/importGuard';

function clientFor(database: string, table: string | null = 'public.cards') {
  return {
    query: jest.fn(async () => ({
      rows: [{ database_name: database, cards_table: table }],
    })),
  };
}

describe('2GIS import target guard', () => {
  it('allows only the dedicated 2gis_dataset database', async () => {
    await expect(assertTwoGisImportTarget(clientFor('2gis_dataset'))).resolves.toBeUndefined();
    await expect(assertTwoGisDatasetTarget(clientFor('2gis_dataset'))).resolves.toBeUndefined();
  });

  it.each(['postgres', 'instantly_dataset', 'instantly'])(
    'rejects unsafe database %s before writes',
    async (database) => {
      const client = clientFor(database);
      await expect(assertTwoGisImportTarget(client)).rejects.toThrow(/2gis_dataset/i);
      expect(client.query).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a database without the expected cards table', async () => {
    await expect(assertTwoGisImportTarget(clientFor('2gis_dataset', null))).rejects.toThrow(
      /cards/i,
    );
  });
});
