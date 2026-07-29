import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  mkdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  FNS_EXACT_CURRENT_TARGET,
  FNS_EXACT_OFFICIAL_ARCHIVE,
  FNS_EXACT_OFFICIAL_XSD,
  processFnsExactPlanFiles,
  type FnsExactPlanManifest,
} from '@/lib/companiesDirectory/fnsExactPlanFiles';
import {
  FnsExactPlanStore,
} from '@/lib/companiesDirectory/fnsExactPlanStore';
import {
  loadFnsExactSnapshot,
} from '@/lib/companiesDirectory/fnsExactSnapshot';
import {
  inspectFnsSmeArchive,
  parseInspectedFnsSmeArchive,
} from '@/lib/companiesDirectory/fnsSmeArchive';
import type {
  FnsSmeInvalidExactOkvedRecord,
} from '@/lib/companiesDirectory/fnsSmeXml';

interface CliArgs {
  archive: string;
  archiveSha256: string;
  archiveBytes: number;
  xsd: string;
  snapshot: string;
  out: string;
}

interface WrittenArtifact {
  sha256: string;
  rows: number;
}

interface SourceQuarantineRow {
  inn: string;
  ogrn: string;
  taxpayer_type: FnsSmeInvalidExactOkvedRecord['taxpayerType'];
  okved_code_exact: string;
  okved_version: FnsSmeInvalidExactOkvedRecord['okvedVersion'];
  document_id: string;
  registry_date: string;
  source_entry_name: string;
  source_file_id: string;
  reason: FnsSmeInvalidExactOkvedRecord['reason'];
  validation_error: string;
}

const MAX_SOURCE_QUARANTINE_ROWS = 100_000;

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`${token} requires a value`);
    }
    values.set(token.slice(2), value);
    index += 1;
  }
  for (const required of [
    'archive',
    'archive-sha256',
    'archive-bytes',
    'xsd',
    'snapshot',
    'out',
  ]) {
    if (!values.get(required)) {
      throw new Error(`--${required} is required`);
    }
  }
  const archiveBytes = Number(values.get('archive-bytes'));
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 1) {
    throw new Error('--archive-bytes must be a positive safe integer');
  }
  return {
    archive: path.resolve(values.get('archive') as string),
    archiveSha256: (values.get('archive-sha256') as string).toLowerCase(),
    archiveBytes,
    xsd: path.resolve(values.get('xsd') as string),
    snapshot: path.resolve(values.get('snapshot') as string),
    out: path.resolve(values.get('out') as string),
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

async function writeJsonl(
  filePath: string,
  rows: Iterable<unknown>,
): Promise<WrittenArtifact> {
  const output = createWriteStream(filePath, {
    flags: 'wx',
    encoding: 'utf8',
  });
  const digest = createHash('sha256');
  let rowCount = 0;
  try {
    for (const row of rows) {
      const line = `${JSON.stringify(row)}\n`;
      digest.update(line);
      rowCount += 1;
      if (!output.write(line)) {
        await once(output, 'drain');
      }
    }
    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    throw error;
  }
  return {
    sha256: digest.digest('hex'),
    rows: rowCount,
  };
}

async function writeJson(
  filePath: string,
  value: unknown,
): Promise<{ sha256: string }> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, text, { flag: 'wx' });
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

async function cleanupSqlite(filePath: string): Promise<void> {
  await Promise.all([
    rm(filePath, { force: true }),
    rm(`${filePath}-journal`, { force: true }),
    rm(`${filePath}-wal`, { force: true }),
    rm(`${filePath}-shm`, { force: true }),
  ]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.archiveBytes !== FNS_EXACT_OFFICIAL_ARCHIVE.bytes) {
    throw new Error(
      `Archive bytes must equal the official pinned size `
      + `${FNS_EXACT_OFFICIAL_ARCHIVE.bytes}`,
    );
  }
  if (path.basename(args.xsd) !== FNS_EXACT_OFFICIAL_XSD.file_name) {
    throw new Error(
      `XSD must be named ${FNS_EXACT_OFFICIAL_XSD.file_name}`,
    );
  }
  if (await pathExists(args.out)) {
    throw new Error(`Output path already exists: ${args.out}`);
  }

  const partialDir = `${args.out}.partial-${process.pid}`;
  const sqlitePath = path.join(partialDir, 'work.sqlite');
  await mkdir(partialDir, { recursive: false });
  const store = new FnsExactPlanStore(sqlitePath);
  let completed = false;

  try {
    process.stdout.write('Validating XSD and official FNS archive...\n');
    const xsdStat = await stat(args.xsd);
    const xsdSha256 = await sha256File(args.xsd);
    if (xsdSha256 !== FNS_EXACT_OFFICIAL_XSD.sha256) {
      throw new Error(
        `XSD SHA-256 mismatch: expected ${FNS_EXACT_OFFICIAL_XSD.sha256}, `
        + `got ${xsdSha256}`,
      );
    }
    const inspection = await inspectFnsSmeArchive({
      archivePath: args.archive,
      expectedBytes: args.archiveBytes,
      expectedSha256: args.archiveSha256,
    });
    process.stdout.write(
      `Archive validated: ${inspection.xmlEntryCount} XML members.\n`,
    );

    process.stdout.write('Loading exact-state Portal snapshot into SQLite...\n');
    const snapshot = await loadFnsExactSnapshot({
      snapshotPath: args.snapshot,
      store,
    });
    process.stdout.write(`Snapshot loaded: ${snapshot.rows} rows.\n`);

    let parsedRecords = 0;
    let duplicateSame = 0;
    const sourceQuarantineRows: SourceQuarantineRow[] = [];
    store.beginRegistry();
    let registryTransactionOpen = true;
    let archiveParse;
    try {
      archiveParse = await parseInspectedFnsSmeArchive({
        inspection,
        onRecord: (record) => {
          const status = store.addRegistry({
            inn: record.inn,
            ogrn: record.ogrn,
            okved_code_exact: record.okvedCodeExact,
            okved_version: record.okvedVersion,
          });
          parsedRecords += 1;
          if (status === 'duplicate_same') duplicateSame += 1;
          if (parsedRecords % 100_000 === 0) {
            process.stdout.write(`registry records: ${parsedRecords}\n`);
          }
        },
        onInvalidIdentity: (record) => {
          if (sourceQuarantineRows.length >= MAX_SOURCE_QUARANTINE_ROWS) {
            throw new Error(
              `FNS source quarantine exceeds ${MAX_SOURCE_QUARANTINE_ROWS} rows`,
            );
          }
          sourceQuarantineRows.push({
            inn: record.inn,
            ogrn: record.ogrn,
            taxpayer_type: record.taxpayerType,
            okved_code_exact: record.okvedCodeExact,
            okved_version: record.okvedVersion,
            document_id: record.documentId,
            registry_date: record.registryDate,
            source_entry_name: record.sourceEntryName,
            source_file_id: record.sourceFileId,
            reason: record.reason,
            validation_error: record.validationError,
          });
        },
      });
      store.commitRegistry();
      registryTransactionOpen = false;
    } catch (error) {
      if (registryTransactionOpen) {
        store.rollbackRegistry();
      }
      throw error;
    }

    process.stdout.write('Classifying update/no-op/conflict rows...\n');
    const metrics = store.metrics();
    const idempotencyCheck = store.checkIdempotency();
    if (
      !idempotencyCheck.passed
      || idempotencyCheck.firstPassUpdates !== metrics.updates
    ) {
      throw new Error('Local FNS exact plan idempotency check failed');
    }

    const updates = await writeJsonl(
      path.join(partialDir, 'updates.jsonl'),
      store.iterateUpdates(),
    );
    const conflicts = await writeJsonl(
      path.join(partialDir, 'conflicts.jsonl'),
      store.iterateConflicts(),
    );
    const skipped = await writeJsonl(
      path.join(partialDir, 'skipped.jsonl'),
      store.iterateSkipped(),
    );
    sourceQuarantineRows.sort((left, right) => {
      if (left.ogrn !== right.ogrn) return left.ogrn < right.ogrn ? -1 : 1;
      if (left.document_id !== right.document_id) {
        return left.document_id < right.document_id ? -1 : 1;
      }
      if (left.source_entry_name === right.source_entry_name) return 0;
      return left.source_entry_name < right.source_entry_name ? -1 : 1;
    });
    const sourceQuarantine = await writeJsonl(
      path.join(partialDir, 'source-quarantine.jsonl'),
      sourceQuarantineRows,
    );
    if (
      updates.rows !== metrics.updates
      || conflicts.rows !== metrics.conflicts
      || skipped.rows !== metrics.skipped
      || sourceQuarantine.rows
        !== archiveParse.metrics.skippedInvalidOgrnCount
    ) {
      throw new Error('Generated artifact row counts differ from SQLite plan');
    }

    const expected = {
      registry_rows: metrics.registry_rows,
      unique_registry_ogrns: metrics.unique_registry_ogrns,
      unique_registry_inns: metrics.unique_registry_inns,
      matched_directory_rows: metrics.matched_directory_rows,
      unique_matched_inns: metrics.unique_matched_inns,
      matched_by_ogrn_rows: metrics.matched_by_ogrn_rows,
      matched_by_unique_inn_rows: metrics.matched_by_unique_inn_rows,
      updates: metrics.updates,
      conflicts: metrics.conflicts,
      skipped: metrics.skipped,
      source_quarantined: sourceQuarantine.rows,
      inserts: 0 as const,
      noops: metrics.noops,
    };
    const source: FnsExactPlanManifest['source'] = {
      archive: {
        ...FNS_EXACT_OFFICIAL_ARCHIVE,
        sha256: inspection.archiveSha256,
      },
      xsd: FNS_EXACT_OFFICIAL_XSD,
      snapshot: {
        version: 2,
        file_name: path.basename(snapshot.snapshotPath),
        bytes: snapshot.bytes,
        sha256: snapshot.sha256,
        rows: snapshot.rows,
        exported_at: snapshot.exported_at,
      },
    };
    const summary = {
      dryRunOnly: true,
      mode: 'existing-only-exact-okved-ogrn-first',
      source,
      target: FNS_EXACT_CURRENT_TARGET,
      combined: expected,
      idempotencyCheck: {
        repeatedUpdates: idempotencyCheck.repeatedUpdates,
        passed: idempotencyCheck.passed,
      },
      audit: {
        xsd_bytes: xsdStat.size,
        archive: {
          xml_entry_count: inspection.xmlEntryCount,
          compressed_bytes: inspection.totalCompressedBytes,
          uncompressed_bytes: inspection.totalUncompressedBytes,
          parser: archiveParse.metrics,
        },
        snapshot_quality: snapshot,
        registry_duplicate_same: duplicateSame,
        source_quarantine: {
          rows: sourceQuarantine.rows,
          reason: 'checksum-invalid official FNS OGRN/OGRNIP',
        },
        registry_not_in_target: metrics.registry_not_in_target,
        okved_2001_quarantined: metrics.okved_2001_quarantined,
        registry_multi_registration_inns:
          metrics.registry_multi_registration_inns,
        target_quarantine: {
          invalid_inn: metrics.invalid_target_inn_quarantined,
          invalid_ogrn: metrics.invalid_target_ogrn_quarantined,
          ogrn_not_found: metrics.ogrn_not_found_quarantined,
          ogrn_inn_mismatch: metrics.identity_mismatch_quarantined,
          inn_not_found: metrics.inn_not_found_quarantined,
          ambiguous_inn: metrics.ambiguous_inn_quarantined,
          legacy_okved_2001:
            metrics.legacy_okved_2001_target_quarantined,
        },
      },
    };
    const summaryArtifact = await writeJson(
      path.join(partialDir, 'summary.json'),
      summary,
    );
    const manifest: FnsExactPlanManifest = {
      version: 2,
      plan: 'fns-exact-okved-2026-07-10-v2',
      source,
      target: FNS_EXACT_CURRENT_TARGET,
      artifacts: {
        'summary.json': summaryArtifact,
        'updates.jsonl': updates,
        'conflicts.jsonl': conflicts,
        'skipped.jsonl': skipped,
        'source-quarantine.jsonl': sourceQuarantine,
      },
      expected,
    };
    const manifestPath = path.join(partialDir, 'manifest.json');
    await writeJson(manifestPath, manifest);

    process.stdout.write('Re-reading and validating frozen artifacts...\n');
    const verified = await processFnsExactPlanFiles({
      planDir: partialDir,
      manifestPath,
      batchSize: 20_000,
    });
    store.close();
    await cleanupSqlite(sqlitePath);
    await rename(partialDir, args.out);
    completed = true;
    process.stdout.write(`${JSON.stringify({
      mode: 'local-plan-only',
      persistentDatabaseWrites: false,
      output: args.out,
      planFingerprint: verified.planFingerprint,
      archiveSha256: inspection.archiveSha256,
      snapshotSha256: snapshot.sha256,
      expected,
      audit: summary.audit,
    }, null, 2)}\n`);
  } finally {
    store.close();
    if (!completed) {
      await rm(partialDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
