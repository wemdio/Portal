import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  validateSbisInsertRow,
  validateSbisPlanManifest,
  validateSbisUpdateRow,
  type SbisPlanManifest,
} from '@/lib/companiesDirectory/sbisPlanApply';
import {
  parseJsonValue,
  readJsonLines,
} from '@/lib/companiesDirectory/planFileIO';

const OPTIONAL_AUDIT_ARTIFACTS = [
  'skipped.jsonl',
  'conflicts.jsonl',
  'provenance.jsonl',
  'source-locations.jsonl',
  'rollback.jsonl',
] as const;

const KNOWN_ARTIFACTS = new Set<string>([
  'summary.json',
  'inserts.jsonl',
  'updates.jsonl',
  'rejected.jsonl',
  ...OPTIONAL_AUDIT_ARTIFACTS,
]);

export interface ProcessSbisPlanFilesOptions {
  planDir: string;
  manifestPath: string;
  batchSize?: number;
  onInsertBatch?: (rows: Record<string, unknown>[]) => Promise<void>;
  onUpdateBatch?: (rows: Record<string, unknown>[]) => Promise<void>;
}

export interface ProcessedSbisPlanFiles {
  manifest: SbisPlanManifest;
  summary: unknown;
  planFingerprint: string;
  insertRows: number;
  updateRows: number;
  approximateOkvedCounts: Record<string, number>;
  artifactHashes: Record<string, string>;
}

function resolveArtifact(planDir: string, name: string): string {
  return path.join(path.resolve(planDir), name);
}

function assertManifest(value: unknown): asserts value is SbisPlanManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SBIS manifest must be an object');
  }
}

function hasOnlyAllowedSources(
  sourceFile: unknown,
  allowedSources: ReadonlySet<string>,
): boolean {
  if (typeof sourceFile !== 'string') return false;
  const parts = sourceFile
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    parts.length > 0
    && new Set(parts).size === parts.length
    && parts.every((part) => allowedSources.has(part))
  );
}

export async function processSbisPlanFiles(
  options: ProcessSbisPlanFilesOptions,
): Promise<ProcessedSbisPlanFiles> {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 2_000) {
    throw new Error('SBIS staging batchSize must be between 1 and 2000');
  }

  const manifestBuffer = await readFile(path.resolve(options.manifestPath));
  const manifest = parseJsonValue<unknown>(manifestBuffer, 'SBIS manifest');
  assertManifest(manifest);

  const summaryPath = resolveArtifact(options.planDir, 'summary.json');
  const summaryBuffer = await readFile(summaryPath);
  const summary = parseJsonValue<unknown>(summaryBuffer, 'summary.json');
  const artifactHashes: Record<string, string> = {
    'summary.json': createHash('sha256')
      .update(summaryBuffer)
      .digest('hex'),
  };
  const artifactRows: Record<string, number> = {};

  for (const artifactName of Object.keys(manifest.artifacts)) {
    if (!KNOWN_ARTIFACTS.has(artifactName)) {
      throw new Error(`SBIS manifest contains unknown artifact ${artifactName}`);
    }
  }

  const insertInns = new Set<string>();
  const updateInns = new Set<string>();
  const allowedSources = new Set(
    manifest.sources.map((source) => source.sourceFile),
  );
  const approximateOkvedCounts: Record<string, number> = {};
  let insertBatch: Record<string, unknown>[] = [];
  const insertResult = await readJsonLines(
    resolveArtifact(options.planDir, 'inserts.jsonl'),
    'inserts.jsonl',
    async (raw) => {
      const row = validateSbisInsertRow(raw, manifest.plan);
      const inn = String(row.inn);
      if (insertInns.has(inn)) {
        throw new Error(`inserts.jsonl contains duplicate INN ${inn}`);
      }
      if (!hasOnlyAllowedSources(row.source_file, allowedSources)) {
        throw new Error(
          `inserts.jsonl INN ${inn} has an unexpected source_file`,
        );
      }
      insertInns.add(inn);
      const okvedCode = String(row.okved_code);
      approximateOkvedCounts[okvedCode] = (
        approximateOkvedCounts[okvedCode] ?? 0
      ) + 1;
      insertBatch.push(row);
      if (insertBatch.length >= batchSize) {
        await options.onInsertBatch?.(insertBatch);
        insertBatch = [];
      }
    },
  );
  if (insertBatch.length > 0) {
    await options.onInsertBatch?.(insertBatch);
  }
  artifactHashes['inserts.jsonl'] = insertResult.sha256;
  artifactRows['inserts.jsonl'] = insertResult.rows;

  let updateBatch: Record<string, unknown>[] = [];
  const updateResult = await readJsonLines(
    resolveArtifact(options.planDir, 'updates.jsonl'),
    'updates.jsonl',
    async (raw) => {
      const row = validateSbisUpdateRow(raw, manifest.plan);
      const inn = String(row.inn);
      if (updateInns.has(inn)) {
        throw new Error(`updates.jsonl contains duplicate INN ${inn}`);
      }
      if (insertInns.has(inn)) {
        throw new Error(
          `SBIS plan contains INN ${inn} in both insert and update artifacts`,
        );
      }
      updateInns.add(inn);
      updateBatch.push(row);
      if (updateBatch.length >= batchSize) {
        await options.onUpdateBatch?.(updateBatch);
        updateBatch = [];
      }
    },
  );
  if (updateBatch.length > 0) {
    await options.onUpdateBatch?.(updateBatch);
  }
  artifactHashes['updates.jsonl'] = updateResult.sha256;
  artifactRows['updates.jsonl'] = updateResult.rows;

  const rejectedResult = await readJsonLines(
    resolveArtifact(options.planDir, 'rejected.jsonl'),
    'rejected.jsonl',
    () => undefined,
  );
  artifactHashes['rejected.jsonl'] = rejectedResult.sha256;
  artifactRows['rejected.jsonl'] = rejectedResult.rows;

  for (const artifactName of OPTIONAL_AUDIT_ARTIFACTS) {
    if (!(artifactName in manifest.artifacts)) continue;
    const result = await readJsonLines(
      resolveArtifact(options.planDir, artifactName),
      artifactName,
      () => undefined,
    );
    artifactHashes[artifactName] = result.sha256;
    artifactRows[artifactName] = result.rows;
  }

  const validation = validateSbisPlanManifest({
    manifest,
    summary,
    artifactHashes,
    artifactRows,
    approximateOkvedCounts,
  });

  return {
    manifest,
    summary,
    planFingerprint: validation.planFingerprint,
    insertRows: insertResult.rows,
    updateRows: updateResult.rows,
    approximateOkvedCounts,
    artifactHashes,
  };
}
