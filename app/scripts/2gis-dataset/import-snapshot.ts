import { basename, resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { Client } from 'pg';
import { assertTwoGisImportTarget } from '../../src/lib/twoGis/importGuard';
import {
  calculateFileSha256,
  createTwoGisHeaderValidator,
  createSepDirectiveStripper,
  TWO_GIS_IMPORT_LOCK,
  validateTwoGisImportStats,
  validateTwoGisLiveSnapshot,
  type TwoGisImportStats,
  type TwoGisLiveSnapshotStats,
} from '../../src/lib/twoGis/importSnapshot';
import { TWO_GIS_SOURCE_COLUMNS } from '../../src/lib/twoGis/types';

interface ImportArgs {
  filePath: string;
  expectedSha256: string;
  snapshotDate: string;
  expectedSourceRows: number;
  expectedAcceptedRows: number;
  psqlBinary: string;
}

function usage(): never {
  throw new Error(
    [
      'Usage:',
      '  import-snapshot --file <csv> --sha256 <hex> --snapshot-date <YYYY-MM-DD>',
      '    --expected-source-rows <n> --expected-accepted-rows <n> [--psql <path>]',
      '',
      'Required environment: TWOGIS_IMPORT_DATABASE_URL',
    ].join('\n'),
  );
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function parseArgs(argv: string[]): ImportArgs {
  const file = readFlag(argv, '--file');
  const sha256 = readFlag(argv, '--sha256')?.toLowerCase();
  const snapshotDate = readFlag(argv, '--snapshot-date');
  if (!file || !sha256 || !snapshotDate) usage();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('--sha256 must contain exactly 64 hexadecimal characters');
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)
    || Number.isNaN(Date.parse(`${snapshotDate}T00:00:00Z`))
  ) {
    throw new Error('--snapshot-date must be a valid YYYY-MM-DD date');
  }
  return {
    filePath: resolve(file),
    expectedSha256: sha256,
    snapshotDate,
    expectedSourceRows: parsePositiveInteger(
      readFlag(argv, '--expected-source-rows'),
      '--expected-source-rows',
    ),
    expectedAcceptedRows: parsePositiveInteger(
      readFlag(argv, '--expected-accepted-rows'),
      '--expected-accepted-rows',
    ),
    psqlBinary: readFlag(argv, '--psql') ?? 'psql',
  };
}

function psqlConnection(databaseUrl: string): {
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('TWOGIS_IMPORT_DATABASE_URL must be a PostgreSQL URL');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const username = decodeURIComponent(url.username);
  if (!url.hostname || !database || !username) {
    throw new Error('TWOGIS_IMPORT_DATABASE_URL must include host, user and database');
  }

  const env = { ...process.env };
  delete env.TWOGIS_IMPORT_DATABASE_URL;
  env.PGPASSWORD = decodeURIComponent(url.password);
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode) env.PGSSLMODE = sslMode;

  return {
    args: [
      '--host',
      url.hostname,
      '--port',
      url.port || '5432',
      '--username',
      username,
      '--dbname',
      database,
      '--no-password',
      '--set',
      'ON_ERROR_STOP=1',
    ],
    env,
  };
}

async function copySnapshotWithPsql(
  args: ImportArgs,
  databaseUrl: string,
): Promise<void> {
  const connection = psqlConnection(databaseUrl);
  const copyCommand =
    `\\copy public.import_staging (${TWO_GIS_SOURCE_COLUMNS.join(', ')}) `
    + `FROM STDIN WITH (FORMAT csv, HEADER false, DELIMITER ';', QUOTE '"', ESCAPE '"')`;
  const child = spawn(
    args.psqlBinary,
    [...connection.args, '--command', copyCommand],
    {
      env: connection.env,
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
    },
  );
  if (!child.stdin) throw new Error('Unable to open psql stdin');

  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveExit();
      } else {
        rejectExit(
          new Error(`psql COPY failed (code=${String(code)}, signal=${String(signal)})`),
        );
      }
    });
  });

  await Promise.all([
    pipeline(
      createReadStream(args.filePath),
      createSepDirectiveStripper(),
      createTwoGisHeaderValidator(TWO_GIS_SOURCE_COLUMNS),
      child.stdin,
    ),
    exited,
  ]);
}

function numberFromRow(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label} returned by PostgreSQL`);
  }
  return parsed;
}

async function readImportStats(client: Client): Promise<TwoGisImportStats> {
  const result = await client.query<{
    source_rows: string;
    accepted_rows: string;
    rejected_rows: string;
    duplicate_ids: string;
  }>(`
    WITH row_stats AS (
      SELECT
        count(*)::bigint AS source_rows,
        count(*) FILTER (WHERE NULLIF(btrim(id), '') IS NOT NULL)::bigint AS accepted_rows,
        count(*) FILTER (WHERE NULLIF(btrim(id), '') IS NULL)::bigint AS rejected_rows
      FROM public.import_staging
    ),
    duplicate_stats AS (
      SELECT count(*)::bigint AS duplicate_ids
      FROM (
        SELECT btrim(id)
        FROM public.import_staging
        WHERE NULLIF(btrim(id), '') IS NOT NULL
        GROUP BY btrim(id)
        HAVING count(*) > 1
      ) duplicates
    )
    SELECT *
    FROM row_stats
    CROSS JOIN duplicate_stats
  `);
  const row = result.rows[0];
  return {
    sourceRows: numberFromRow(row?.source_rows, 'source row count'),
    acceptedRows: numberFromRow(row?.accepted_rows, 'accepted row count'),
    rejectedRows: numberFromRow(row?.rejected_rows, 'rejected row count'),
    duplicateIds: numberFromRow(row?.duplicate_ids, 'duplicate ID count'),
  };
}

async function recreateCardIndexes(client: Client): Promise<void> {
  await client.query(`
    CREATE INDEX cards_city_name_id_idx ON public.cards (city_name, id);
    CREATE INDEX cards_category_id_idx ON public.cards (category, id);
    CREATE INDEX cards_city_category_id_idx ON public.cards (city_name, category, id);
    CREATE INDEX cards_has_phone_id_idx ON public.cards (id) WHERE has_phone;
    CREATE INDEX cards_has_email_id_idx ON public.cards (id) WHERE has_email;
    CREATE INDEX cards_has_website_id_idx ON public.cards (id) WHERE has_website;
    CREATE INDEX cards_has_vkontakte_id_idx ON public.cards (id) WHERE has_vkontakte;
    CREATE INDEX cards_has_instagram_id_idx ON public.cards (id) WHERE has_instagram;
    CREATE INDEX cards_name_trgm_idx ON public.cards USING gin (name gin_trgm_ops);
    CREATE INDEX card_subcategories_value_card_id_idx
      ON public.card_subcategories (value, card_id);
    CREATE INDEX card_subcategories_category_value_card_id_idx
      ON public.card_subcategories (category, value, card_id);
  `);
}

async function finalizeSnapshot(
  client: Client,
  args: ImportArgs,
  stats: TwoGisImportStats,
): Promise<number> {
  await client.query('BEGIN');
  try {
    await client.query(`
      DROP INDEX IF EXISTS public.cards_city_name_id_idx;
      DROP INDEX IF EXISTS public.cards_category_id_idx;
      DROP INDEX IF EXISTS public.cards_city_category_id_idx;
      DROP INDEX IF EXISTS public.cards_has_phone_id_idx;
      DROP INDEX IF EXISTS public.cards_has_email_id_idx;
      DROP INDEX IF EXISTS public.cards_has_website_id_idx;
      DROP INDEX IF EXISTS public.cards_has_vkontakte_id_idx;
      DROP INDEX IF EXISTS public.cards_has_instagram_id_idx;
      DROP INDEX IF EXISTS public.cards_name_trgm_idx;
      DROP INDEX IF EXISTS public.card_subcategories_value_card_id_idx;
      DROP INDEX IF EXISTS public.card_subcategories_category_value_card_id_idx;

      TRUNCATE TABLE public.card_subcategories, public.cards;

      INSERT INTO public.cards (${TWO_GIS_SOURCE_COLUMNS.join(', ')})
      SELECT
        btrim(id),
        COALESCE(name, ''),
        COALESCE(city_name, ''),
        COALESCE(geometry_name, ''),
        COALESCE(post_code, ''),
        COALESCE(phone, ''),
        COALESCE(email, ''),
        COALESCE(website, ''),
        COALESCE(vkontakte, ''),
        COALESCE(instagram, ''),
        COALESCE(lon, ''),
        COALESCE(lat, ''),
        COALESCE(category, ''),
        COALESCE(subcategory, '')
      FROM public.import_staging
      WHERE NULLIF(btrim(id), '') IS NOT NULL;

      INSERT INTO public.card_subcategories (card_id, category, value)
      SELECT
        cards.id,
        cards.category,
        btrim(parts.value)
      FROM public.cards AS cards
      CROSS JOIN LATERAL regexp_split_to_table(
        cards.subcategory,
        '\\s*,\\s*'
      ) AS parts(value)
      WHERE btrim(parts.value) <> ''
      ON CONFLICT (card_id, value) DO NOTHING;
    `);

    await recreateCardIndexes(client);

    const snapshot = await client.query<{ id: string }>(
      `INSERT INTO public.dataset_snapshots
        (
          scope,
          snapshot_date,
          source_filename,
          source_sha256,
          source_rows,
          accepted_rows,
          rejected_rows
        )
       VALUES ('Россия', $1::date, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        args.snapshotDate,
        basename(args.filePath),
        args.expectedSha256,
        stats.sourceRows,
        stats.acceptedRows,
        stats.rejectedRows,
      ],
    );
    const snapshotId = numberFromRow(snapshot.rows[0]?.id, 'snapshot ID');

    await client.query(
      `INSERT INTO public.import_rejects (snapshot_id, reason, source_row)
       SELECT
         $1,
         'blank_id',
         jsonb_build_object(
           'id', id,
           'name', name,
           'city_name', city_name,
           'geometry_name', geometry_name,
           'post_code', post_code,
           'phone', phone,
           'email', email,
           'website', website,
           'vkontakte', vkontakte,
           'instagram', instagram,
           'lon', lon,
           'lat', lat,
           'category', category,
           'subcategory', subcategory
         )
       FROM public.import_staging
       WHERE NULLIF(btrim(id), '') IS NULL`,
      [snapshotId],
    );

    await client.query(`
      TRUNCATE TABLE
        public.facet_cities,
        public.facet_categories,
        public.facet_subcategories,
        public.export_tickets;

      INSERT INTO public.facet_cities (value, row_count)
      SELECT city_name, count(*)::bigint
      FROM public.cards
      WHERE btrim(city_name) <> ''
      GROUP BY city_name;

      INSERT INTO public.facet_categories (value, row_count)
      SELECT category, count(*)::bigint
      FROM public.cards
      WHERE btrim(category) <> ''
      GROUP BY category;

      INSERT INTO public.facet_subcategories (category, value, row_count)
      SELECT category, value, count(*)::bigint
      FROM public.card_subcategories
      WHERE btrim(category) <> ''
      GROUP BY category, value;

      ANALYZE public.cards;
      ANALYZE public.card_subcategories;
      ANALYZE public.facet_cities;
      ANALYZE public.facet_categories;
      ANALYZE public.facet_subcategories;
      TRUNCATE TABLE public.import_staging;
    `);
    await client.query('COMMIT');
    return snapshotId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function readLiveSnapshot(
  client: Client,
  snapshotId: number,
): Promise<{
  stats: TwoGisLiveSnapshotStats;
  verification: Record<string, unknown>;
}> {
  const result = await client.query(
    `SELECT
       (SELECT count(*)::bigint FROM public.cards) AS cards,
       (SELECT count(DISTINCT id)::bigint FROM public.cards) AS unique_ids,
       (SELECT accepted_rows FROM public.dataset_snapshots WHERE id = $1) AS accepted_rows,
       (SELECT count(*)::bigint FROM public.import_rejects WHERE snapshot_id = $1) AS rejects,
       (SELECT count(*)::bigint FROM public.card_subcategories) AS normalized_subcategories,
       (SELECT count(*)::bigint FROM public.facet_subcategories) AS subcategory_facets`,
    [snapshotId],
  );
  const row = result.rows[0];
  return {
    stats: {
      cards: numberFromRow(row?.cards, 'live card count'),
      uniqueIds: numberFromRow(row?.unique_ids, 'live unique ID count'),
      acceptedRows: numberFromRow(
        row?.accepted_rows,
        'audited accepted row count',
      ),
      normalizedSubcategories: numberFromRow(
        row?.normalized_subcategories,
        'normalized subcategory count',
      ),
      subcategoryFacets: numberFromRow(
        row?.subcategory_facets,
        'subcategory facet count',
      ),
    },
    verification: row as Record<string, unknown>,
  };
}

async function verifyLiveSnapshot(
  client: Client,
  snapshotId: number,
  expectedAcceptedRows: number,
): Promise<Record<string, unknown>> {
  const live = await readLiveSnapshot(client, snapshotId);
  validateTwoGisLiveSnapshot(live.stats, expectedAcceptedRows);
  return live.verification;
}

async function findAlreadyCurrentSnapshot(
  client: Client,
  args: ImportArgs,
): Promise<{ snapshotId: number; verification: Record<string, unknown> } | null> {
  const latest = await client.query<{
    id: string;
    source_sha256: string;
    accepted_rows: string;
  }>(
    `SELECT id, source_sha256, accepted_rows
     FROM public.dataset_snapshots
     ORDER BY imported_at DESC
     LIMIT 1`,
  );
  const row = latest.rows[0];
  if (
    !row
    || row.source_sha256 !== args.expectedSha256
    || numberFromRow(row.accepted_rows, 'existing accepted row count')
      !== args.expectedAcceptedRows
  ) {
    return null;
  }
  const snapshotId = numberFromRow(row.id, 'existing snapshot ID');
  const live = await readLiveSnapshot(client, snapshotId);
  try {
    validateTwoGisLiveSnapshot(live.stats, args.expectedAcceptedRows);
    return { snapshotId, verification: live.verification };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.TWOGIS_IMPORT_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('TWOGIS_IMPORT_DATABASE_URL is required');
  }

  console.log(`Verifying source SHA-256: ${args.filePath}`);
  const actualSha256 = await calculateFileSha256(args.filePath);
  if (actualSha256 !== args.expectedSha256) {
    throw new Error(
      `Source SHA-256 mismatch: expected ${args.expectedSha256}, got ${actualSha256}`,
    );
  }

  const client = new Client({
    connectionString: databaseUrl,
    statement_timeout: 0,
    query_timeout: 0,
    application_name: 'portal-2gis-import',
  });
  await client.connect();

  let lockHeld = false;
  try {
    await assertTwoGisImportTarget(client);
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [TWO_GIS_IMPORT_LOCK]);
    lockHeld = true;

    const alreadyCurrent = await findAlreadyCurrentSnapshot(client, args);
    if (alreadyCurrent) {
      console.log(
        JSON.stringify(
          {
            state: 'already_current',
            database: '2gis_dataset',
            snapshotId: alreadyCurrent.snapshotId,
            sha256: actualSha256,
            ...alreadyCurrent.verification,
          },
          null,
          2,
        ),
      );
      return;
    }

    await client.query('TRUNCATE TABLE public.import_staging');

    console.log('Copying CSV into isolated UNLOGGED staging table...');
    await copySnapshotWithPsql(args, databaseUrl);

    const stats = await readImportStats(client);
    validateTwoGisImportStats(stats, {
      expectedSourceRows: args.expectedSourceRows,
      expectedAcceptedRows: args.expectedAcceptedRows,
    });
    console.log(`Validated staging rows: ${JSON.stringify(stats)}`);

    const snapshotId = await finalizeSnapshot(client, args, stats);
    const verification = await verifyLiveSnapshot(
      client,
      snapshotId,
      args.expectedAcceptedRows,
    );
    console.log(
      JSON.stringify(
        {
          state: 'completed',
          database: '2gis_dataset',
          snapshotId,
          sha256: actualSha256,
          ...verification,
        },
        null,
        2,
      ),
    );
  } finally {
    if (lockHeld) {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [TWO_GIS_IMPORT_LOCK])
        .catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
