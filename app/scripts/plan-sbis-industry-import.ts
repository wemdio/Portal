/**
 * Builds a local, read-only import plan for an SBIS XLSX export.
 *
 * This script never connects to Postgres and has no apply mode. It writes
 * JSON/JSONL artifacts that can be reviewed before a separately authorized
 * production import.
 *
 * From app/:
 *   node_modules/.bin/esbuild scripts/plan-sbis-industry-import.ts \
 *     --bundle --platform=node --target=node20 --outfile=.tmp/plan-sbis-import.cjs
 *   node .tmp/plan-sbis-import.cjs \
 *     --mode contact-only \
 *     --input "C:\path\Компании (1).xlsx" \
 *     --input "C:\path\Компании (2).xlsx" \
 *     --snapshot "C:\tmp\portal-company-sites.tsv.gz" \
 *     --out "C:\tmp\sbis-contact-plan"
 */

import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import Papa from 'papaparse';
import * as XLSX from 'xlsx';

import {
  SBIS_APPROXIMATE_OKVED_BY_ACTIVITY,
  applySbisImportPlan,
  buildSbisContactImportPlan,
  buildSbisIndustryImportPlan,
  collapseSbisRowsByInn,
  mapSbisWorksheetRecord,
  normalizeSbisInn,
  validateSbisWorksheetHeaders,
  type DirectoryInsert,
  type DirectoryUpdate,
  type ExistingDirectoryRow,
  type SbisDirectoryInputRow,
  type SbisImportPlan,
} from '@/lib/companiesDirectory/sbisImportPlan';

interface CliArgs {
  inputs: string[];
  snapshot: string;
  out: string;
  mode: 'industry' | 'contact-only';
  industryCode: string;
}

const SNAPSHOT_TEXT_FIELDS = [
  'name',
  'kpp',
  'address',
  'director_last_name',
  'director_first_name',
  'director_middle_name',
  'activity_type',
  'phones',
  'email',
  'edo_id',
  'okpo',
  'pf_reg_number',
  'branch_code',
  'website',
  'egais',
  'gln',
  'ogrn',
  'region_code',
  'okved_code',
  'okved_code_exact',
  'okved_exact_source',
  'source_file',
] as const;

const SNAPSHOT_NUMBER_FIELDS = [
  'employees_count',
  'revenue',
  'cost',
] as const;

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Для --${name} не указано значение`);
    }
    const current = values.get(name) ?? [];
    current.push(value);
    values.set(name, current);
    index += 1;
  }

  const inputs = values.get('input') ?? [];
  const snapshot = values.get('snapshot')?.at(-1);
  const out = values.get('out')?.at(-1);
  if (inputs.length === 0 || !snapshot || !out) {
    throw new Error(
      'Обязательные аргументы: --input <xlsx> --snapshot <tsv[.gz]> --out <dir>',
    );
  }

  const modeValue = values.get('mode')?.at(-1) ?? 'industry';
  if (modeValue !== 'industry' && modeValue !== 'contact-only') {
    throw new Error('Режим --mode должен быть industry или contact-only');
  }
  const industryCode = (values.get('industry-code')?.at(-1) ?? '62').trim();
  if (!/^\d{2}(?:\.\d{1,2}){0,2}$/.test(industryCode)) {
    throw new Error(`Некорректный приблизительный код отрасли: ${industryCode}`);
  }
  return {
    inputs: inputs.map((input) => path.resolve(input)),
    snapshot: path.resolve(snapshot),
    out: path.resolve(out),
    mode: modeValue,
    industryCode,
  };
}

function readSbisWorkbook(filePath: string): SbisDirectoryInputRow[] {
  const workbook = XLSX.readFile(filePath, {
    cellDates: false,
    dense: true,
  });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('В XLSX нет листов');
  const sheet = workbook.Sheets[sheetName];

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: true,
  });
  const header = (matrix[0] ?? []).map((value) => String(value ?? '').trim());
  validateSbisWorksheetHeaders(header);

  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: true,
  });
  return records.map((record, index) =>
    mapSbisWorksheetRecord(record, index + 2),
  );
}

function blankToNull(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function parseSnapshotInteger(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function snapshotRowToDirectoryRow(
  row: Record<string, unknown>,
): ExistingDirectoryRow | null {
  const inn = normalizeSbisInn(row.inn);
  const id = blankToNull(row.id);
  if (!inn || !id) return null;

  const existing: ExistingDirectoryRow = { id, inn };
  for (const field of SNAPSHOT_TEXT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      existing[field] = blankToNull(row[field]);
    }
  }
  for (const field of SNAPSHOT_NUMBER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      existing[field] = parseSnapshotInteger(row[field]);
    }
  }
  return existing;
}

async function readMatchingSnapshotRows(
  snapshotPath: string,
  incomingInns: ReadonlySet<string>,
): Promise<ExistingDirectoryRow[]> {
  const parser = Papa.parse(Papa.NODE_STREAM_INPUT, {
    header: true,
    delimiter: '\t',
    skipEmptyLines: true,
  });
  const matches: ExistingDirectoryRow[] = [];
  parser.on('data', (row: Record<string, unknown>) => {
    const inn = normalizeSbisInn(row.inn);
    if (!inn || !incomingInns.has(inn)) return;
    const existing = snapshotRowToDirectoryRow(row);
    if (existing) matches.push(existing);
  });

  const source = createReadStream(snapshotPath);
  if (snapshotPath.toLowerCase().endsWith('.gz')) {
    await pipeline(source, createGunzip(), parser);
  } else {
    await pipeline(source, parser);
  }
  return matches;
}

async function writeJsonLines(
  filePath: string,
  rows: Iterable<unknown>,
): Promise<void> {
  const output = createWriteStream(filePath, { encoding: 'utf8' });
  for (const row of rows) {
    if (!output.write(`${JSON.stringify(row)}\n`)) {
      await once(output, 'drain');
    }
  }
  output.end();
  await once(output, 'finish');
}

async function sha256(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

interface SourceWorkbook {
  filePath: string;
  sourceFile: string;
  sha256: string;
  rows: SbisDirectoryInputRow[];
  collapsed: ReturnType<typeof collapseSbisRowsByInn>;
}

interface SourceRowProvenance {
  source_file: string;
  sha256: string;
  rowNumbers: number[];
}

interface UpdateFieldProvenance {
  id: number | string;
  inn: string;
  fields: Map<string, Set<string>>;
}

function buildPlan(
  args: CliArgs,
  source: SourceWorkbook,
  existingRows: ExistingDirectoryRow[],
): SbisImportPlan {
  if (args.mode === 'contact-only') {
    return buildSbisContactImportPlan(
      source.rows,
      existingRows,
      { sourceFile: source.sourceFile },
    );
  }
  return buildSbisIndustryImportPlan(
    source.rows,
    existingRows,
    {
      approximateOkvedCode: args.industryCode,
      sourceFile: source.sourceFile,
    },
  );
}

function safeStageName(index: number, sourceFile: string): string {
  const stem = path.basename(sourceFile, path.extname(sourceFile))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return `${String(index + 1).padStart(2, '0')}-${stem}`;
}

function sourceLocations(
  source: SourceWorkbook,
): unknown[] {
  return source.collapsed.companies
    .filter((company) => company.rowNumbers.length > 1)
    .map((company) => ({
      source_file: source.sourceFile,
      inn: company.inn,
      canonical: {
        name: company.name,
        kpp: company.kpp,
        address: company.address,
      },
      rowNumbers: company.rowNumbers,
      locations: company.locations,
    }));
}

async function writeStageArtifacts(
  stageOut: string,
  source: SourceWorkbook,
  plan: SbisImportPlan,
  summary: unknown,
): Promise<void> {
  await mkdir(stageOut, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(stageOut, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    ),
    writeJsonLines(path.join(stageOut, 'inserts.jsonl'), plan.inserts),
    writeJsonLines(path.join(stageOut, 'updates.jsonl'), plan.updates),
    writeJsonLines(path.join(stageOut, 'skipped.jsonl'), plan.skipped),
    writeJsonLines(path.join(stageOut, 'conflicts.jsonl'), plan.conflicts),
    writeJsonLines(path.join(stageOut, 'rejected.jsonl'), plan.rejected),
    writeJsonLines(
      path.join(stageOut, 'source-locations.jsonl'),
      sourceLocations(source),
    ),
  ]);
}

function isDryRunInsertId(id: number | string): boolean {
  return String(id).startsWith('dry-run-insert:');
}

function mergeUpdate(
  updatesById: Map<string, DirectoryUpdate>,
  update: DirectoryUpdate,
): void {
  const key = String(update.id);
  const current = updatesById.get(key);
  updatesById.set(key, {
    id: update.id,
    inn: update.inn,
    patch: {
      ...(current?.patch ?? {}),
      ...update.patch,
    },
  });
}

function contactShape(rows: Array<{
  website?: unknown;
  email?: unknown;
}>): {
  total: number;
  both: number;
  websiteOnly: number;
  emailOnly: number;
  neither: number;
} {
  const result = {
    total: rows.length,
    both: 0,
    websiteOnly: 0,
    emailOnly: 0,
    neither: 0,
  };
  for (const row of rows) {
    const website = Boolean(row.website);
    const email = Boolean(row.email);
    if (website && email) result.both += 1;
    else if (website) result.websiteOnly += 1;
    else if (email) result.emailOnly += 1;
    else result.neither += 1;
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sources: SourceWorkbook[] = [];
  for (const filePath of args.inputs) {
    const rows = readSbisWorkbook(filePath);
    sources.push({
      filePath,
      sourceFile: path.basename(filePath),
      sha256: await sha256(filePath),
      rows,
      collapsed: collapseSbisRowsByInn(rows),
    });
  }

  const incomingInns = new Set(
    sources.flatMap((source) =>
      source.collapsed.companies.map((company) => company.inn),
    ),
  );
  const existingRows = await readMatchingSnapshotRows(
    args.snapshot,
    incomingInns,
  );

  await mkdir(args.out, { recursive: true });
  const sourceProvenanceByInn = new Map<
    string,
    Map<string, SourceRowProvenance>
  >();
  for (const source of sources) {
    for (const company of source.collapsed.companies) {
      const provenance = sourceProvenanceByInn.get(company.inn)
        ?? new Map<string, SourceRowProvenance>();
      provenance.set(source.sourceFile, {
        source_file: source.sourceFile,
        sha256: source.sha256,
        rowNumbers: company.rowNumbers,
      });
      sourceProvenanceByInn.set(company.inn, provenance);
    }
  }

  let workingRows = existingRows;
  const realUpdatesById = new Map<string, DirectoryUpdate>();
  const contributingSourcesByInn = new Map<string, Set<string>>();
  const updateFieldProvenanceById = new Map<
    string,
    UpdateFieldProvenance
  >();
  const allConflicts: unknown[] = [];
  const allSkipped: unknown[] = [];
  const allRejected: unknown[] = [];
  const allLocations: unknown[] = [];
  const stageSummaries: unknown[] = [];

  for (const [index, source] of sources.entries()) {
    const plan = buildPlan(args, source, workingRows);
    for (const insert of plan.inserts) {
      const contributors = contributingSourcesByInn.get(insert.inn)
        ?? new Set<string>();
      contributors.add(source.sourceFile);
      contributingSourcesByInn.set(insert.inn, contributors);
    }
    for (const update of plan.updates) {
      const contributors = contributingSourcesByInn.get(update.inn)
        ?? new Set<string>();
      contributors.add(source.sourceFile);
      contributingSourcesByInn.set(update.inn, contributors);
      if (!isDryRunInsertId(update.id)) {
        mergeUpdate(realUpdatesById, update);
        const key = String(update.id);
        const provenance = updateFieldProvenanceById.get(key) ?? {
          id: update.id,
          inn: update.inn,
          fields: new Map<string, Set<string>>(),
        };
        for (const field of Object.keys(update.patch)) {
          const fieldSources = provenance.fields.get(field)
            ?? new Set<string>();
          fieldSources.add(source.sourceFile);
          provenance.fields.set(field, fieldSources);
        }
        updateFieldProvenanceById.set(key, provenance);
      }
    }
    allConflicts.push(
      ...plan.conflicts.map((conflict) => ({
        source_file: source.sourceFile,
        ...conflict,
      })),
    );
    allSkipped.push(
      ...plan.skipped.map((skipped) => ({
        source_file: source.sourceFile,
        ...skipped,
      })),
    );
    allRejected.push(
      ...plan.rejected.map((rejected) => ({
        source_file: source.sourceFile,
        ...rejected,
      })),
    );
    allLocations.push(...sourceLocations(source));

    const stageSummary = {
      index: index + 1,
      sourceFile: source.sourceFile,
      sha256: source.sha256,
      metrics: plan.metrics,
      contactShape: contactShape(plan.inserts),
      existingRowsGettingWebsite: plan.updates.filter(
        (update) => Boolean(update.patch.website),
      ).length,
      existingRowsGettingEmail: plan.updates.filter(
        (update) => Boolean(update.patch.email),
      ).length,
      existingRowsGettingApproximateIndustry: plan.updates.filter(
        (update) => Boolean(update.patch.okved_code),
      ).length,
      idempotentWhenAppliedAlone: (() => {
        const afterStage = applySbisImportPlan(workingRows, plan);
        const repeated = buildPlan(args, source, afterStage);
        return repeated.metrics.inserts === 0
          && repeated.metrics.updates === 0;
      })(),
    };
    stageSummaries.push(stageSummary);
    await writeStageArtifacts(
      path.join(
        args.out,
        'stages',
        safeStageName(index, source.sourceFile),
      ),
      source,
      plan,
      stageSummary,
    );
    workingRows = applySbisImportPlan(workingRows, plan);
  }

  const combinedInserts = workingRows
    .filter((row) => isDryRunInsertId(row.id))
    .map((row) => {
      const inn = normalizeSbisInn(row.inn);
      if (!inn) {
        throw new Error(`Некорректный ИНН в итоговом dry-run: ${String(row.inn)}`);
      }
      const fields = Object.fromEntries(
        Object.entries(row).filter(([field]) => field !== 'id'),
      ) as unknown as DirectoryInsert;
      return {
        ...fields,
        inn,
        source_file: [
          ...(contributingSourcesByInn.get(inn) ?? []),
        ].join(', '),
      } satisfies DirectoryInsert;
    })
    .sort((left, right) => left.inn.localeCompare(right.inn));
  const combinedUpdates = [...realUpdatesById.values()]
    .sort((left, right) => left.inn.localeCompare(right.inn));
  const resolveSourceProvenance = (
    inn: string,
    sourceFiles: Iterable<string>,
  ): SourceRowProvenance[] =>
    [...sourceFiles]
      .map((sourceFile) =>
        sourceProvenanceByInn.get(inn)?.get(sourceFile),
      )
      .filter(
        (item): item is SourceRowProvenance => Boolean(item),
      );
  const provenanceRows = [
    ...combinedInserts.map((insert) => ({
      action: 'insert',
      inn: insert.inn,
      sources: resolveSourceProvenance(
        insert.inn,
        contributingSourcesByInn.get(insert.inn) ?? [],
      ),
    })),
    ...combinedUpdates.map((update) => {
      const provenance = updateFieldProvenanceById.get(String(update.id));
      return {
        action: 'update',
        id: update.id,
        inn: update.inn,
        fields: Object.fromEntries(
          [
            ...(
              provenance?.fields
              ?? new Map<string, Set<string>>()
            ).entries(),
          ]
            .map(([field, sourceFiles]) => [
              field,
              resolveSourceProvenance(update.inn, sourceFiles),
            ]),
        ),
      };
    }),
  ];

  let idempotencyRows = workingRows;
  let repeatedInserts = 0;
  let repeatedUpdates = 0;
  for (const source of sources) {
    const repeated = buildPlan(args, source, idempotencyRows);
    repeatedInserts += repeated.metrics.inserts;
    repeatedUpdates += repeated.metrics.updates;
    idempotencyRows = applySbisImportPlan(idempotencyRows, repeated);
  }

  const activityCounts = [...combinedInserts.reduce(
    (counts, row) => {
      const activity = String(row.activity_type ?? '(не указано)');
      counts.set(activity, (counts.get(activity) ?? 0) + 1);
      return counts;
    },
    new Map<string, number>(),
  ).entries()]
    .sort((left, right) => right[1] - left[1]);
  const approximateOkvedCounts = [...combinedInserts.reduce(
    (counts, row) => {
      const okvedCode = String(row.okved_code ?? '(не указан)');
      counts.set(okvedCode, (counts.get(okvedCode) ?? 0) + 1);
      return counts;
    },
    new Map<string, number>(),
  ).entries()]
    .sort((left, right) => right[1] - left[1]);
  const combinedContactUpdates = combinedUpdates.filter(
    (update) => Boolean(update.patch.website) || Boolean(update.patch.email),
  );
  const combinedApproximateIndustryUpdates = combinedUpdates.filter(
    (update) => Boolean(update.patch.okved_code),
  );
  const summary = {
    generatedAt: new Date().toISOString(),
    dryRunOnly: true,
    mode: args.mode,
    input: {
      files: sources.map((source) => ({
        file: source.filePath,
        sourceFile: source.sourceFile,
        sha256: source.sha256,
        inputRows: source.rows.length,
        uniqueInns: source.collapsed.companies.length,
      })),
      snapshot: args.snapshot,
      approximateIndustryCode:
        args.mode === 'industry' ? args.industryCode : null,
      approximateIndustryMapping:
        args.mode === 'contact-only'
          ? SBIS_APPROXIMATE_OKVED_BY_ACTIVITY
          : null,
    },
    stages: stageSummaries,
    combined: {
      inputRows: sources.reduce(
        (total, source) => total + source.rows.length,
        0,
      ),
      uniqueIncomingInns: incomingInns.size,
      matchedSnapshotRows: existingRows.length,
      inserts: combinedInserts.length,
      updates: combinedUpdates.length,
      contactUpdates: combinedContactUpdates.length,
      approximateIndustryUpdates:
        combinedApproximateIndustryUpdates.length,
      skipped: allSkipped.length,
      conflicts: allConflicts.length,
      rejectedRows: allRejected.length,
      insertsWithNonNullApproximateOkved: combinedInserts.filter(
        (insert) => Boolean(insert.okved_code),
      ).length,
      contactShape: contactShape(combinedInserts),
      activityCounts,
      approximateOkvedCounts,
      provenanceRecords: provenanceRows.length,
    },
    idempotencyCheck: {
      repeatedInserts,
      repeatedUpdates,
      passed: repeatedInserts === 0 && repeatedUpdates === 0,
    },
  };

  await Promise.all([
    writeFile(
      path.join(args.out, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    ),
    writeJsonLines(path.join(args.out, 'inserts.jsonl'), combinedInserts),
    writeJsonLines(path.join(args.out, 'updates.jsonl'), combinedUpdates),
    writeJsonLines(path.join(args.out, 'skipped.jsonl'), allSkipped),
    writeJsonLines(path.join(args.out, 'conflicts.jsonl'), allConflicts),
    writeJsonLines(path.join(args.out, 'rejected.jsonl'), allRejected),
    writeJsonLines(path.join(args.out, 'provenance.jsonl'), provenanceRows),
    writeJsonLines(
      path.join(args.out, 'source-locations.jsonl'),
      allLocations,
    ),
  ]);

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
