/**
 * Builds a deterministic, read-only contact import plan from guarded registry
 * ZIP/CSV sources. This script never connects to Postgres and has no apply mode.
 *
 * From app/:
 *   node_modules/.bin/esbuild scripts/plan-polza-registry-v2.ts \
 *     --bundle --platform=node --target=node22 --format=cjs \
 *     --outfile=.tmp/plan-polza-registry-v2.cjs --external:pg
 *   node .tmp/plan-polza-registry-v2.cjs \
 *     --archive-dir "C:\path\registry" \
 *     --input-csv "C:\path\WIRUJA.csv" \
 *     --snapshot "C:\path\target_snapshot.tsv" \
 *     --out "C:\path\polza-registry-v2-plan"
 */

import { createHash } from 'node:crypto';
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import Papa from 'papaparse';

import {
  POLZA_REGISTRY_V2_PLAN,
  POLZA_REGISTRY_V2_REQUIRED_AUDIT_ARTIFACTS,
  buildSbisPlanFingerprint,
  type SbisPlanManifest,
} from '@/lib/companiesDirectory/sbisPlanApply';
import {
  RegistryV2ArchiveError,
  readRegistryV2Archive,
  readRegistryV2CsvFile,
} from '@/lib/companiesDirectory/registryCsvArchive';
import {
  buildRegistryV2PlanBundle,
  type RegistryV2PlanSource,
} from '@/lib/companiesDirectory/registryV2Plan';
import type { ExistingDirectoryRow } from '@/lib/companiesDirectory/sbisImportPlan';

interface CliArgs {
  archiveDir: string;
  inputCsvs: string[];
  snapshot: string;
  out: string;
}

const SNAPSHOT_FIELDS = [
  'name', 'kpp', 'address', 'director_last_name', 'director_first_name',
  'director_middle_name', 'activity_type', 'phones', 'email', 'edo_id',
  'okpo', 'pf_reg_number', 'branch_code', 'website', 'egais', 'gln', 'ogrn',
  'region_code', 'okved_code', 'okved_code_exact', 'okved_exact_source',
  'source_file',
] as const;

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    const name = token.slice(2);
    values.set(name, [...(values.get(name) ?? []), value]);
    index += 1;
  }
  const archiveDir = values.get('archive-dir')?.at(-1);
  const snapshot = values.get('snapshot')?.at(-1);
  const out = values.get('out')?.at(-1);
  if (!archiveDir || !snapshot || !out) {
    throw new Error('--archive-dir, --snapshot and --out are required');
  }
  const known = new Set(['archive-dir', 'input-csv', 'snapshot', 'out']);
  for (const key of values.keys()) {
    if (!known.has(key)) throw new Error(`Unknown argument: --${key}`);
  }
  return {
    archiveDir: path.resolve(archiveDir),
    inputCsvs: (values.get('input-csv') ?? []).map((value) => path.resolve(value)),
    snapshot: path.resolve(snapshot),
    out: path.resolve(out),
  };
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nullableText(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function nullableInteger(value: unknown): number | null {
  const text = nullableText(value);
  if (!text) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function readSnapshot(filePath: string): Promise<ExistingDirectoryRow[]> {
  const bytes = await readFile(filePath);
  const decoded = filePath.toLowerCase().endsWith('.gz') ? gunzipSync(bytes) : bytes;
  const parsed = Papa.parse<Record<string, string>>(
    new TextDecoder('utf-8', { fatal: true }).decode(decoded),
    { header: true, delimiter: '\t', skipEmptyLines: 'greedy' },
  );
  if (parsed.errors.length > 0) {
    throw new Error(`Snapshot parse errors: ${JSON.stringify(parsed.errors.slice(0, 5))}`);
  }
  const fields = new Set(parsed.meta.fields ?? []);
  for (const required of ['id', 'inn']) {
    if (!fields.has(required)) throw new Error(`Snapshot is missing ${required}`);
  }
  return parsed.data.map((row) => {
    const result: ExistingDirectoryRow = {
      id: row.id,
      inn: row.inn,
    };
    for (const field of SNAPSHOT_FIELDS) {
      if (fields.has(field)) result[field] = nullableText(row[field]);
    }
    for (const field of ['employees_count', 'revenue', 'cost'] as const) {
      if (fields.has(field)) result[field] = nullableInteger(row[field]);
    }
    return result;
  });
}

async function readSources(args: CliArgs): Promise<RegistryV2PlanSource[]> {
  const entries = (await readdir(args.archiveDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru-RU'));
  const sources: RegistryV2PlanSource[] = [];

  for (const entry of entries) {
    const archivePath = path.join(args.archiveDir, entry.name);
    try {
      const result = await readRegistryV2Archive(archivePath);
      sources.push({
        sourceFile: result.archiveName,
        sourceSha256: result.archiveSha256,
        csvSha256: result.csvSha256,
        entryName: result.entryName,
        schema: result.schema,
        inputRows: result.inputRows,
        activeRows: result.activeRows,
        filteredStatuses: result.filteredStatuses,
        sourceBytes: result.archiveBytes,
        uncompressedBytes: result.uncompressedBytes,
      });
    } catch (error) {
      if (!(error instanceof RegistryV2ArchiveError) || error.code !== 'empty_archive') {
        throw error;
      }
      const bytes = await readFile(archivePath);
      sources.push({
        sourceFile: entry.name,
        sourceSha256: sha256(bytes),
        csvSha256: null,
        entryName: null,
        schema: null,
        inputRows: 0,
        activeRows: [],
        filteredStatuses: [],
        sourceBytes: bytes.length,
        uncompressedBytes: 0,
        error: error.code,
      });
    }
  }

  for (const csvPath of [...args.inputCsvs].sort((left, right) =>
    path.basename(left).localeCompare(path.basename(right), 'ru-RU')
  )) {
    const result = await readRegistryV2CsvFile(csvPath);
    sources.push({
      sourceFile: result.sourceFile,
      sourceSha256: result.fileSha256,
      csvSha256: result.fileSha256,
      entryName: result.sourceFile,
      schema: result.schema,
      inputRows: result.inputRows,
      activeRows: result.activeRows,
      filteredStatuses: result.filteredStatuses,
      sourceBytes: result.fileBytes,
      uncompressedBytes: result.fileBytes,
    });
  }
  if (sources.length === 0) throw new Error('No registry ZIP/CSV sources found');
  return sources;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeJsonLines(filePath: string, rows: unknown[]): Promise<void> {
  const text = rows.map((row) => JSON.stringify(row)).join('\n');
  await writeFile(filePath, text ? `${text}\n` : '', 'utf8');
}

async function hashFile(filePath: string): Promise<string> {
  return sha256(await readFile(filePath));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [sources, existingRows] = await Promise.all([
    readSources(args),
    readSnapshot(args.snapshot),
  ]);
  const bundle = buildRegistryV2PlanBundle(sources, existingRows);
  const idempotency = bundle.summary.idempotencyCheck as Record<string, unknown>;
  if (idempotency.passed !== true) {
    throw new Error('Registry v2 plan failed the idempotency check');
  }
  await mkdir(args.out, { recursive: true });

  const artifactRows: Record<string, unknown[]> = {
    'inserts.jsonl': bundle.plan.inserts,
    'updates.jsonl': bundle.plan.updates,
    'rejected.jsonl': bundle.plan.rejected,
    'skipped.jsonl': bundle.plan.skipped,
    'conflicts.jsonl': bundle.plan.conflicts,
    'provenance.jsonl': bundle.provenance,
    'source-locations.jsonl': bundle.sourceLocations,
    'source-archives.jsonl': bundle.sourceArchives,
    'filtered-status.jsonl': bundle.filteredStatuses,
    'rollback.jsonl': bundle.rollback,
  };
  await Promise.all([
    writeJson(path.join(args.out, 'summary.json'), bundle.summary),
    ...Object.entries(artifactRows).map(([name, rows]) =>
      writeJsonLines(path.join(args.out, name), rows)
    ),
  ]);

  const artifacts: SbisPlanManifest['artifacts'] = {
    'summary.json': { sha256: await hashFile(path.join(args.out, 'summary.json')) },
    'inserts.jsonl': { sha256: '', rows: 0 },
    'updates.jsonl': { sha256: '', rows: 0 },
    'rejected.jsonl': { sha256: '', rows: 0 },
  };
  for (const [name, rows] of Object.entries(artifactRows)) {
    const artifactName = name as keyof typeof artifacts;
    artifacts[artifactName] = {
      sha256: await hashFile(path.join(args.out, name)),
      rows: rows.length,
    };
  }
  for (const name of POLZA_REGISTRY_V2_REQUIRED_AUDIT_ARTIFACTS) {
    if (!(name in artifacts)) throw new Error(`Missing generated artifact ${name}`);
  }

  const combined = bundle.summary.combined as Record<string, unknown>;
  const approximateOkvedCounts = Object.fromEntries(
    combined.approximateOkvedCounts as Array<[string, number]>,
  );
  const manifest: SbisPlanManifest = {
    version: 1,
    plan: POLZA_REGISTRY_V2_PLAN,
    target: {
      host: '139.60.162.12',
      port: 35434,
      database: 'postgres',
    },
    sources: bundle.manifestSources,
    artifacts,
    expected: {
      inputRows: Number(combined.inputRows),
      uniqueIncomingInns: Number(combined.uniqueIncomingInns),
      inserts: bundle.plan.inserts.length,
      updates: bundle.plan.updates.length,
      skipped: bundle.plan.skipped.length,
      rejectedRows: bundle.plan.rejected.length,
      approximateOkvedCounts,
    },
  };
  const manifestPath = path.join(args.out, 'manifest.json');
  await writeJson(manifestPath, manifest);
  process.stdout.write(`${JSON.stringify({
    dryRunOnly: true,
    out: args.out,
    manifestPath,
    planFingerprint: buildSbisPlanFingerprint(manifest),
    expected: manifest.expected,
    updateFields: combined.updateFields,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
