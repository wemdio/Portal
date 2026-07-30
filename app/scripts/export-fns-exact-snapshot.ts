import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createGzip } from 'node:zlib';

import { Client } from 'pg';

import {
  assertFnsProductionTarget,
} from '@/lib/companiesDirectory/fnsExactApply';
import {
  verifyFnsExactDatabaseIdentity,
  type FnsExactPgClient,
} from '@/lib/companiesDirectory/fnsExactPostgresApply';

interface CliArgs {
  out: string;
  confirmedTarget: string;
}

function parseArgs(argv: string[]): CliArgs {
  let out = '';
  let confirmedTarget = '';
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${token} requires a value`);
    }
    if (token === '--out') {
      out = path.resolve(value);
    } else if (token === '--confirm-target') {
      confirmedTarget = value;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
    index += 1;
  }
  if (!out || !confirmedTarget) {
    throw new Error('--out and --confirm-target are required');
  }
  return { out, confirmedTarget };
}

function databaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error('DATABASE_URL is required for the read-only snapshot');
  }
  return value;
}

async function writeLine(
  gzip: ReturnType<typeof createGzip>,
  value: unknown,
): Promise<void> {
  if (!gzip.write(`${JSON.stringify(value)}\n`)) {
    await once(gzip, 'drain');
  }
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = databaseUrl();
  const target = assertFnsProductionTarget(url, args.confirmedTarget);
  const partialPath = `${args.out}.partial-${process.pid}`;
  const output = createWriteStream(partialPath, {
    flags: 'wx',
  });
  const gzip = createGzip({ level: 6 });
  gzip.pipe(output);

  const client = new Client({ connectionString: url });
  await client.connect();
  let transactionOpen = false;
  let rows = 0;
  try {
    await client.query(
      "SELECT set_config('application_name', $1, false)",
      ['fns-exact-okved-readonly-snapshot'],
    );
    await verifyFnsExactDatabaseIdentity(
      client as unknown as FnsExactPgClient,
    );
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '2h'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '2h'");
    await client.query(`
DECLARE fns_exact_snapshot NO SCROLL CURSOR FOR
SELECT
  id::text AS id,
  inn,
  ogrn,
  okved_code_exact,
  okved_exact_source
FROM public.companies_directory
WHERE inn IS NOT NULL
ORDER BY id
`.trim());

    await writeLine(gzip, {
      kind: 'meta',
      version: 2,
      source: {
        ...target,
        table: 'companies_directory',
      },
      exported_at: new Date().toISOString(),
    });

    while (true) {
      const batch = await client.query(
        'FETCH FORWARD 10000 FROM fns_exact_snapshot',
      );
      if (batch.rows.length === 0) break;
      for (const row of batch.rows) {
        await writeLine(gzip, {
          id: String(row.id),
          inn: String(row.inn),
          ogrn:
            row.ogrn === null
              ? null
              : String(row.ogrn),
          okved_code_exact:
            row.okved_code_exact === null
              ? null
              : String(row.okved_code_exact),
          okved_exact_source:
            row.okved_exact_source === null
              ? null
              : String(row.okved_exact_source),
        });
        rows += 1;
      }
      if (rows % 100_000 === 0) {
        process.stdout.write(`snapshot rows: ${rows}\n`);
      }
    }
    await client.query('CLOSE fns_exact_snapshot');
    await client.query('COMMIT');
    transactionOpen = false;
    gzip.end();
    await once(output, 'finish');
    await rename(partialPath, args.out);
    const sha256 = await sha256File(args.out);
    process.stdout.write(`${JSON.stringify({
      mode: 'read-only-snapshot',
      persistentDatabaseWrites: false,
      target,
      out: args.out,
      rows,
      sha256,
    }, null, 2)}\n`);
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
    }
    gzip.destroy();
    output.destroy();
    await rm(partialPath, { force: true });
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
