interface ImportGuardClient {
  query: (text: string, params?: unknown[]) => Promise<{
    rows: Array<{ database_name?: string; cards_table?: string | null }>;
  }>;
}

const EXPECTED_DATABASE = '2gis_dataset';

export async function assertTwoGisDatasetTarget(client: ImportGuardClient): Promise<void> {
  const result = await client.query(`
    SELECT
      current_database() AS database_name,
      to_regclass('public.cards')::text AS cards_table
  `);
  const identity = result.rows[0];
  if (identity?.database_name !== EXPECTED_DATABASE) {
    throw new Error(
      `Refusing 2GIS import: expected database ${EXPECTED_DATABASE}, got ${
        identity?.database_name ?? 'unknown'
      }`,
    );
  }
  if (!identity.cards_table || !['cards', 'public.cards'].includes(identity.cards_table)) {
    throw new Error('Refusing 2GIS import: expected public.cards table is missing');
  }
}

export const assertTwoGisImportTarget = assertTwoGisDatasetTarget;
