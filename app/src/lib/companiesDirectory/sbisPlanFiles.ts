import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  validateSbisInsertRow,
  validateSbisPlanManifest,
  validateSbisUpdateRow,
  type SbisPlanManifest,
} from '@/lib/companiesDirectory/sbisPlanApply';

interface JsonLineResult {
  rows: number;
  sha256: string;
}

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

function parseJson<T>(raw: Buffer | string, label: string): T {
  try {
    return JSON.parse(raw.toString()) as T;
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function readJsonLines(
  filePath: string,
  label: string,
  onRow: (value: unknown, rowNumber: number) => Promise<void> | void,
): Promise<JsonLineResult> {
  const digest = createHash('sha256');
  const decoder = new StringDecoder('utf8');
  const stream = createReadStream(filePath);
  let pending = '';
  let rows = 0;

  const handleLine = async (rawLine: string): Promise<void> => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      throw new Error(`${label} contains an empty JSONL line`);
    }
    rows += 1;
    await onRow(parseJson(line, `${label}:${rows}`), rows);
  };

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk);
    digest.update(chunk);
    pending += decoder.write(chunk);
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      await handleLine(line);
      newlineIndex = pending.indexOf('\n');
    }
  }
  pending += decoder.end();
  if (pending !== '') {
    await handleLine(pending);
  }

  return {
    rows,
    sha256: digest.digest('hex'),
  };
}

async function readPossiblyEmptyJsonLines(
  filePath: string,
  label: string,
): Promise<JsonLineResult> {
  const digest = createHash('sha256');
  const decoder = new StringDecoder('utf8');
  const stream = createReadStream(filePath);
  let pending = '';
  let rows = 0;

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk);
    digest.update(chunk);
    pending += decoder.write(chunk);
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
      pending = pending.slice(newlineIndex + 1);
      if (line !== '') {
        rows += 1;
      }
      newlineIndex = pending.indexOf('\n');
    }
  }
  pending += decoder.end();
  if (pending.replace(/\r$/, '') !== '') {
    rows += 1;
  }

  if (rows > 0) {
    throw new Error(`${label} must be empty, got ${rows} rows`);
  }
  return {
    rows,
    sha256: digest.digest('hex'),
  };
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
  const manifest = parseJson<unknown>(manifestBuffer, 'SBIS manifest');
  assertManifest(manifest);

  const summaryPath = resolveArtifact(options.planDir, 'summary.json');
  const summaryBuffer = await readFile(summaryPath);
  const summary = parseJson<unknown>(summaryBuffer, 'summary.json');
  const artifactHashes: Record<string, string> = {
    'summary.json': createHash('sha256').update(summaryBuffer).digest('hex'),
  };

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
      const row = validateSbisInsertRow(raw);
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

  let updateBatch: Record<string, unknown>[] = [];
  const updateResult = await readJsonLines(
    resolveArtifact(options.planDir, 'updates.jsonl'),
    'updates.jsonl',
    async (raw) => {
      const row = validateSbisUpdateRow(raw);
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

  const rejectedResult = await readPossiblyEmptyJsonLines(
    resolveArtifact(options.planDir, 'rejected.jsonl'),
    'rejected.jsonl',
  );
  artifactHashes['rejected.jsonl'] = rejectedResult.sha256;

  const validation = validateSbisPlanManifest({
    manifest,
    summary,
    artifactHashes,
    artifactRows: {
      'inserts.jsonl': insertResult.rows,
      'updates.jsonl': updateResult.rows,
      'rejected.jsonl': rejectedResult.rows,
    },
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
