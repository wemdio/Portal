/** Operator tool; dry-run by default. Build from app/ with the installed tool:
 * node_modules/.bin/esbuild scripts/vertical-engine-v2/repair-preview-geography.ts --bundle --platform=node --format=cjs --target=node22 --conditions=react-server --external:pg --outfile=dist/scripts/repair-preview-geography.cjs
 * Dedicated VE_GEOGRAPHY_REPAIR_DATABASE_URL only; generic/prod URLs are never inferred.
 * --request reviewed.json [--output dry-run.json] [--apply --confirm-target host/database] [--continue]
 * Take the `artifact` object from the dry-run output as the next --request file.
 * An apply flag is not a substitute for the production approval required by AGENTS.md.
 */
import { open, readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { applyVeCollectionGeographyRepair, type VeGeographyRepairArtifact } from '@/lib/verticalEngineV2/collectionGeographyRepairApply';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let requestPath: string | undefined, outputPath: string | undefined, confirmedTarget: string | undefined;
  let apply = false, continueCollection = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--continue') continueCollection = true;
    else if (['--request', '--output', '--confirm-target'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--request') requestPath = value;
      if (arg === '--output') outputPath = value;
      if (arg === '--confirm-target') confirmedTarget = value;
    } else throw new Error('Unsupported argument; use --request, --output, --apply, --continue, --confirm-target');
  }
  if (!requestPath) throw new Error('--request is required');
  if (continueCollection && !apply) throw new Error('--continue requires --apply');
  const connectionString = process.env.VE_GEOGRAPHY_REPAIR_DATABASE_URL;
  if (!connectionString) throw new Error('VE_GEOGRAPHY_REPAIR_DATABASE_URL is required; no default database is used');
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL connection URL');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const target = `${url.hostname}${url.port ? ':' + url.port : ''}/${database}`;
  if (apply && confirmedTarget !== target) throw new Error('--apply requires --confirm-target matching the configured host[:port]/database');
  const parsed = JSON.parse(await readFile(requestPath, 'utf8')) as VeGeographyRepairArtifact;
  // Reserve the output before opening a DB transaction: an existing path or a
  // missing directory must not turn a successful commit into a silent failure.
  const outputFile = outputPath ? await open(outputPath, 'wx', 0o600) : null;
  const client = new Client({ connectionString, application_name: apply ? 've-geography-repair-apply' : 've-geography-repair-dry-run',
    connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const identity = (await client.query(`select current_database() database,
      to_regclass('public.ve_bases')::text bases,to_regclass('public.ve_outreach_preparations')::text preparations`)).rows[0];
    if (identity.database !== database || !identity.bases || !identity.preparations) throw new Error('Configured database is not a Portal VE2 database');
    const result = await applyVeCollectionGeographyRepair(client, parsed, { apply, continueCollection });
    const output = JSON.stringify({ ...result, target }, null, 2) + '\n';
    // The receipt remains visible even if the local filesystem fills after a
    // database commit; repeating the artifact resolves the original job ID.
    process.stdout.write(output);
    if (outputFile) {
      try { await outputFile.writeFile(output); }
      catch { throw new Error(`Database operation returned ${result.status}; local output write failed. The receipt is printed above; retrying the same request is idempotent.`); }
    }
    if (result.status === 'blocked') process.exitCode = 2;
  } finally {
    try { await client.end(); } finally { await outputFile?.close(); }
  }
}

main().catch((error) => {
  // Never print a connection string, passwords, company rows or raw SQL detail.
  const message = error instanceof Error ? error.message : 'Unknown geography repair failure';
  process.stderr.write(message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[database URL redacted]') + '\n');
  process.exitCode = 1;
});
