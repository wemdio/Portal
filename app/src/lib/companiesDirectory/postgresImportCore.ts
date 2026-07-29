export interface ImportPgQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

export interface ImportPgClient {
  query(sql: string, values?: unknown[]): Promise<ImportPgQueryResult>;
}

export async function beginImportTransaction(
  client: ImportPgClient,
  statement: 'BEGIN READ ONLY' | 'BEGIN READ WRITE',
  options: {
    lockTimeout: string;
    statementTimeout: string;
    idleTimeout: string;
  },
): Promise<void> {
  await client.query(statement);
  try {
    await client.query(`SET LOCAL lock_timeout = '${options.lockTimeout}'`);
    await client.query(
      `SET LOCAL statement_timeout = '${options.statementTimeout}'`,
    );
    await client.query(
      `SET LOCAL idle_in_transaction_session_timeout = '${options.idleTimeout}'`,
    );
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original setup error.
    }
    throw error;
  }
}

export async function verifyPortalCompaniesDirectoryIdentity(
  client: ImportPgClient,
): Promise<{
  database: string;
  directoryTable: string;
}> {
  const result = await client.query(`
SELECT
  current_database() AS database,
  to_regclass('public.companies_directory')::text AS directory_table
`.trim());
  const row = result.rows[0];
  const database = String(row?.database ?? '');
  const directoryTable = String(row?.directory_table ?? '');
  if (
    database !== 'postgres'
    || !['companies_directory', 'public.companies_directory'].includes(
      directoryTable,
    )
  ) {
    throw new Error(
      'Connected database identity is not the current Portal companies directory',
    );
  }
  return {
    database,
    directoryTable,
  };
}
