/**
 * Builds a deterministic update-only exact OKVED plan from the pinned SBIS
 * registry analysis and a read-only target snapshot. This script has no
 * database connection and no apply mode.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

import {
  canonicalJson,
  isJsonObject,
  sha256Hex,
} from '@/lib/companiesDirectory/guardedImportCore';
import {
  buildSbisExactDecisionSnapshot,
  type SbisExactDecisionCandidate,
  type SbisExactDecisionTargetRow,
} from '@/lib/companiesDirectory/sbisExactDecisionSnapshot';
import {
  buildSbisExactOkvedPlan,
  type SbisExactOkvedSourceRow,
} from '@/lib/companiesDirectory/sbisExactOkvedPlan';
import {
  buildSbisExactPlanFingerprint,
  processSbisExactPlanFiles,
  type SbisExactPlanManifest,
} from '@/lib/companiesDirectory/sbisExactPlanFiles';
import { parseJsonValue, readJsonLines } from '@/lib/companiesDirectory/planFileIO';
import {
  OKVED2_TREE,
  type OkvedNode,
} from '@/lib/companiesSearch/okved2';

interface CliArgs {
  analysis: string;
  locations: string;
  registryManifest: string;
  snapshot: string;
  out: string;
}

const SOURCE_ANALYSIS_SHA256 =
  '351ac4660cc0242e453ed8f0ce1c7ce415fb165441c8b2a67c73c11d922028d7';
const SOURCE_LOCATIONS_SHA256 =
  '55526b74173593d752f57609d98ede0a14d359b038cbd8005bf4c787bbc0f526';
const REGISTRY_MANIFEST_SHA256 =
  'b3688f8c511349f86d1075fad46e25def272e835e04388239a56c36468d64a8e';
const TARGET_SNAPSHOT_SHA256 =
  'f7c5d898c7f802105cfae89330c62b0812bcf523ffa937783dffbbe73fc3dc6d';
const EXPECTED_CANDIDATE_DIGEST =
  'e1c5648f9943be0d486edd90f73e66c267272744fb43ffb0de6a6464d3ab40c7';
const SOURCE_CANDIDATES = 134_199;
const SOURCE_LOCATIONS_ROWS = 160_028;
const TARGET_SNAPSHOT_ROWS = 146_471;
const TARGET = {
  host: '139.60.162.12',
  port: 35434,
  database: 'postgres',
  table: 'companies_directory',
} as const;
const REFERENCE = {
  count: 2_680,
  md5: '83d8fe43ba6c52b8e11024258a467783',
} as const;
const SNAPSHOT_BASELINE = {
  total_rows: 2_407_996,
  null_pair: 718_711,
  partial_pair: 0,
} as const;
const JSONL_ARTIFACTS = [
  'updates.jsonl',
  'noops.jsonl',
  'conflicts.jsonl',
  'skipped.jsonl',
  'source-quarantine.jsonl',
  'provenance.jsonl',
  'rollback.jsonl',
] as const;

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`${flag ?? '(missing flag)'} requires a value`);
    }
    const key = flag.slice(2);
    if (values.has(key)) throw new Error(`Duplicate argument: ${flag}`);
    values.set(key, value);
  }
  const required = ['analysis', 'locations', 'registry-manifest', 'snapshot', 'out'];
  for (const key of required) {
    if (!values.has(key)) throw new Error(`--${key} is required`);
  }
  for (const key of values.keys()) {
    if (!required.includes(key)) throw new Error(`Unknown argument: --${key}`);
  }
  return {
    analysis: path.resolve(values.get('analysis') as string),
    locations: path.resolve(values.get('locations') as string),
    registryManifest: path.resolve(values.get('registry-manifest') as string),
    snapshot: path.resolve(values.get('snapshot') as string),
    out: path.resolve(values.get('out') as string),
  };
}

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

async function assertPinnedFile(
  filePath: string,
  expectedSha256: string,
  label: string,
): Promise<void> {
  if (await hashFile(filePath) !== expectedSha256) {
    throw new Error(`${label} SHA-256 does not match the pinned input`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be non-empty text`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function candidateKey(candidate: {
  ordinal: number;
  inn: string;
  ogrn: string;
  okved_code_exact: string;
}): string {
  return sha256Hex(canonicalJson(candidate));
}

function loadPinnedReferenceCodes(): Set<string> {
  const codes: string[] = [];
  const visit = (nodes: readonly OkvedNode[]): void => {
    for (const node of nodes) {
      if (/^\d{2}(?:\.\d{1,2}){0,2}$/.test(node.code)) codes.push(node.code);
      if (node.children) visit(node.children);
    }
  };
  visit(OKVED2_TREE);
  const unique = [...new Set(codes)].sort();
  const md5 = createHash('md5').update(unique.join('\n')).digest('hex');
  if (unique.length !== REFERENCE.count || md5 !== REFERENCE.md5) {
    throw new Error(
      `Local OKVED reference does not match the pinned production reference: `
      + `${unique.length}/${md5}`,
    );
  }
  return new Set(unique);
}

async function loadSourceRows(
  candidates: readonly SbisExactDecisionCandidate[],
  locationsPath: string,
): Promise<SbisExactOkvedSourceRow[]> {
  const candidateByInn = new Map(candidates.map((candidate) => [
    candidate.inn,
    candidate,
  ]));
  const evidenceByInn = new Map<string, Array<{
    source_file: string;
    sha256: string;
    rowNumbers: number[];
  }>>();
  const result = await readJsonLines(locationsPath, 'source locations', (value) => {
    const row = record(value, 'source location');
    const inn = text(row.inn, 'source location INN');
    if (!candidateByInn.has(inn)) return;
    const sourceFile = text(row.source_file, 'source file');
    const sha256 = text(row.source_sha256, 'source SHA').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid source SHA');
    if (!Array.isArray(row.rowNumbers) || row.rowNumbers.length < 1) {
      throw new Error('Source rowNumbers must be non-empty');
    }
    const rowNumbers = row.rowNumbers.map((number) => {
      const value = integer(number, 'source row number');
      if (value < 1) throw new Error('Source row number must be positive');
      return value;
    });
    const evidence = evidenceByInn.get(inn) ?? [];
    evidence.push({ source_file: sourceFile, sha256, rowNumbers });
    evidenceByInn.set(inn, evidence);
  });
  if (result.rows !== SOURCE_LOCATIONS_ROWS) {
    throw new Error(`Expected ${SOURCE_LOCATIONS_ROWS} source location rows`);
  }
  const sourceRows: SbisExactOkvedSourceRow[] = [];
  for (const candidate of candidates) {
    const evidence = evidenceByInn.get(candidate.inn) ?? [];
    if (evidence.length < 1) {
      throw new Error(`No source evidence for candidate ${candidate.ordinal}`);
    }
    for (const item of evidence) {
      for (const rowNumber of item.rowNumbers) {
        sourceRows.push({
          inn: candidate.inn,
          ogrn: candidate.ogrn,
          okved_code_exact: candidate.okved_code_exact,
          source_file: item.source_file,
          source_sha256: item.sha256,
          row_number: rowNumber,
        });
      }
    }
  }
  return sourceRows;
}

async function loadTargetSnapshot(
  filePath: string,
  candidates: readonly SbisExactDecisionCandidate[],
): Promise<{
  meta: Record<string, unknown>;
  targetRows: SbisExactDecisionTargetRow[];
}> {
  const lines = createInterface({
    input: createReadStream(filePath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  let meta: Record<string, unknown> | null = null;
  let previousOrdinal = 0;
  let previousId = BigInt(0);
  const candidateByOrdinal = new Map(candidates.map((candidate) => [
    candidate.ordinal,
    candidate,
  ]));
  const targetRows: SbisExactDecisionTargetRow[] = [];
  for await (const line of lines) {
    lineNumber += 1;
    const row = record(parseJsonValue(line, `snapshot:${lineNumber}`), 'snapshot row');
    if (lineNumber === 1) {
      meta = row;
      continue;
    }
    if (row.kind !== undefined && row.kind !== 'target') {
      throw new Error('Unexpected target snapshot row kind');
    }
    const ordinal = integer(row.ordinal, 'target candidate ordinal');
    if (ordinal < 1) throw new Error('Target candidate ordinal must be positive');
    const candidate = candidateByOrdinal.get(ordinal);
    if (!candidate) throw new Error(`Unknown target candidate ordinal ${ordinal}`);
    if (
      row.candidate_key_sha256 !== candidate.candidate_key_sha256
      || row.inn !== candidate.inn
    ) {
      throw new Error(`Target candidate identity drift at ordinal ${ordinal}`);
    }
    const id = text(row.id, 'target id');
    if (!/^\d+$/.test(id) || BigInt(id) < BigInt(1)) {
      throw new Error('Target id must be a positive integer');
    }
    const numericId = BigInt(id);
    if (ordinal < previousOrdinal || (ordinal === previousOrdinal && numericId <= previousId)) {
      throw new Error('Target snapshot rows are not strictly ordered');
    }
    previousOrdinal = ordinal;
    previousId = numericId;
    targetRows.push({
      id,
      inn: candidate.inn,
      ogrn: row.ogrn === null ? null : text(row.ogrn, 'target OGRN'),
      okved_code_exact: row.okved_code_exact === null
        ? null
        : text(row.okved_code_exact, 'target exact OKVED'),
      okved_exact_source: row.okved_exact_source === null
        ? null
        : text(row.okved_exact_source, 'target exact source'),
    });
  }
  if (!meta) throw new Error('Target snapshot is empty');
  if (targetRows.length !== TARGET_SNAPSHOT_ROWS) {
    throw new Error(`Expected ${TARGET_SNAPSHOT_ROWS} target rows`);
  }
  return { meta, targetRows };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeJsonl(filePath: string, rows: readonly unknown[]): Promise<void> {
  await writeFile(
    filePath,
    rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
    'utf8',
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    await access(args.out);
    throw new Error('Output directory must not already exist');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  await Promise.all([
    assertPinnedFile(args.analysis, SOURCE_ANALYSIS_SHA256, 'Source analysis'),
    assertPinnedFile(args.locations, SOURCE_LOCATIONS_SHA256, 'Source locations'),
    assertPinnedFile(
      args.registryManifest,
      REGISTRY_MANIFEST_SHA256,
      'Registry manifest',
    ),
    assertPinnedFile(args.snapshot, TARGET_SNAPSHOT_SHA256, 'Target snapshot'),
  ]);
  const stage = `${args.out}.partial-${process.pid}`;
  await mkdir(stage, { recursive: false });
  try {
    const analysis = record(
      parseJsonValue(await readFile(args.analysis), 'source analysis'),
      'source analysis',
    );
    if (!Array.isArray(analysis.candidates)) {
      throw new Error('Source analysis candidates must be an array');
    }
    const candidates: SbisExactDecisionCandidate[] = analysis.candidates
      .map((value, index) => {
        const row = record(value, `source candidate ${index + 1}`);
        return {
          inn: text(row.inn, 'candidate INN'),
          ogrn: text(row.ogrn, 'candidate OGRN'),
          okved_code_exact: text(row.code, 'candidate exact OKVED'),
        };
      })
      .sort((left, right) => left.inn.localeCompare(right.inn))
      .map((row, index) => {
        const identity = { ordinal: index + 1, ...row };
        return { ...identity, candidate_key_sha256: candidateKey(identity) };
      });
    if (candidates.length !== SOURCE_CANDIDATES) {
      throw new Error(`Expected ${SOURCE_CANDIDATES} source candidates`);
    }
    const candidateDigest = sha256Hex(
      `${candidates.map((candidate) => [
        candidate.inn,
        candidate.ogrn,
        candidate.okved_code_exact,
      ].join('\t')).join('\n')}\n`,
    );
    if (candidateDigest !== EXPECTED_CANDIDATE_DIGEST) {
      throw new Error('Source candidate digest does not match the pinned snapshot');
    }
    const [sourceRows, snapshot] = await Promise.all([
      loadSourceRows(candidates, args.locations),
      loadTargetSnapshot(args.snapshot, candidates),
    ]);
    if (
      snapshot.meta.kind !== 'meta'
      || snapshot.meta.version !== 1
      || snapshot.meta.source !== 'sbis_registry'
      || snapshot.meta.candidate_count !== SOURCE_CANDIDATES
      || snapshot.meta.target_rows !== TARGET_SNAPSHOT_ROWS
      || snapshot.meta.source_analysis_sha256 !== SOURCE_ANALYSIS_SHA256
      || snapshot.meta.candidate_digest !== EXPECTED_CANDIDATE_DIGEST
      || snapshot.meta.isolation !== 'repeatable read read only'
      || snapshot.meta.persistentApplicationWrites !== false
      || canonicalJson(snapshot.meta.baseline) !== canonicalJson(SNAPSHOT_BASELINE)
      || canonicalJson(snapshot.meta.okved_reference) !== canonicalJson(REFERENCE)
      || canonicalJson(snapshot.meta.target) !== canonicalJson(TARGET)
    ) {
      throw new Error('Target snapshot metadata does not match pinned inputs');
    }
    const decisions = buildSbisExactDecisionSnapshot({
      source: 'sbis_registry',
      candidates,
      targetRows: snapshot.targetRows,
    });
    const eligible = decisions.decisions.filter(
      (decision) => decision.category === 'eligible_null_unique_inn',
    );
    const targetsById = new Map(snapshot.targetRows.map((row) => [String(row.id), row]));
    const eligibleTargets = eligible.map((decision) => {
      const id = decision.target?.id;
      const target = id ? targetsById.get(id) : undefined;
      if (!target) throw new Error(`Eligible target is missing for ${decision.ordinal}`);
      return target;
    });
    const referenceCodes = loadPinnedReferenceCodes();
    const plan = buildSbisExactOkvedPlan(sourceRows, eligibleTargets, referenceCodes);
    if (plan.updates.length !== eligible.length || plan.updates.length !== 48_140) {
      throw new Error(
        `Expected 48140 safe updates, got ${plan.updates.length}/${eligible.length}`,
      );
    }
    if (plan.conflicts.length || plan.noops.length || plan.sourceQuarantine.length) {
      throw new Error('Safe eligible subset produced unexpected planner decisions');
    }
    const updateById = new Map(plan.updates.map((update) => [update.id, update]));
    const replay = buildSbisExactDecisionSnapshot({
      source: 'sbis_registry',
      candidates,
      targetRows: snapshot.targetRows.map((row) => {
        const update = updateById.get(String(row.id));
        return update
          ? {
            ...row,
            okved_code_exact: update.okved_code_exact,
            okved_exact_source: update.okved_exact_source,
          }
          : row;
      }),
    });
    const repeatedEligible = replay.decisions.filter(
      (decision) => decision.category === 'eligible_null_unique_inn',
    );
    const replayedAsSame = replay.decisions.filter((decision) => (
      updateById.has(decision.target?.id ?? '')
      && decision.category === 'occupied_same'
    ));
    if (repeatedEligible.length !== 0 || replayedAsSame.length !== plan.updates.length) {
      throw new Error('Exact OKVED plan failed the idempotency replay');
    }
    const nonEligible = decisions.decisions.filter(
      (decision) => decision.category !== 'eligible_null_unique_inn',
    );
    const noops = nonEligible.filter((decision) => decision.category === 'occupied_same')
      .map((decision) => {
        const id = decision.target?.id;
        if (!id) throw new Error(`Noop target missing at ordinal ${decision.ordinal}`);
        return {
          id,
          inn: decision.inn,
          expected_ogrn: decision.ogrn,
          registry_ogrn: decision.ogrn,
          match_method: 'ogrn_inn',
          reason: 'already_exact',
        };
      });
    const conflicts = nonEligible
      .filter((decision) => [
        'occupied_different', 'partial_exact_state',
      ].includes(decision.category))
      .map((decision) => {
        const target = decision.target;
        if (!target) throw new Error(`Conflict target missing at ${decision.ordinal}`);
        return {
          id: target.id,
          inn: decision.inn,
          expected_ogrn: decision.ogrn,
          registry_ogrn: decision.ogrn,
          match_method: 'ogrn_inn',
          kind: decision.category === 'partial_exact_state'
            ? 'partial_existing_exact_state'
            : 'existing_exact_preserved',
          existing_okved_code_exact: target.okved_code_exact,
          existing_okved_exact_source: target.okved_exact_source,
          incoming_okved_code_exact: decision.okved_code_exact,
          incoming_okved_exact_source: 'sbis_registry',
        };
      });
    const skipped = nonEligible
      .filter((decision) => ![
        'occupied_same', 'occupied_different', 'partial_exact_state',
      ].includes(decision.category))
      .map((decision) => ({
        inn: decision.inn,
        registry_ogrn: decision.ogrn,
        reason: decision.category === 'absent_inn' || decision.category === 'ogrn_mismatch'
          ? 'target_identity_not_found'
          : decision.category === 'eligible_null_extra_inn'
            ? 'ambiguous_target_inn'
            : 'ambiguous_target_identity',
        ...(
          decision.category === 'eligible_null_extra_inn'
            ? { target_ids: decision.inn_target_ids }
            : decision.category === 'duplicate_identity'
              ? { target_ids: decision.identity_target_ids }
            : {}
        ),
      }));
    const rollback = plan.updates.map((update) => ({
      action: 'restore_exact',
      id: update.id,
      inn: update.inn,
      expected_ogrn: update.expected_ogrn,
      okved_code_exact: null,
      okved_exact_source: null,
    }));
    const sourceQuarantine: unknown[] = [];
    const artifactRows = {
      'updates.jsonl': plan.updates,
      'noops.jsonl': noops,
      'conflicts.jsonl': conflicts,
      'skipped.jsonl': skipped,
      'source-quarantine.jsonl': sourceQuarantine,
      'provenance.jsonl': plan.provenance,
      'rollback.jsonl': rollback,
    };
    const snapshotStats = await stat(args.snapshot);
    const snapshotMeta = {
      file_name: path.basename(args.snapshot),
      sha256: TARGET_SNAPSHOT_SHA256,
      candidate_rows: SOURCE_CANDIDATES,
      target_rows: TARGET_SNAPSHOT_ROWS,
      exported_at: text(snapshot.meta.exported_at, 'snapshot exported_at'),
      target: TARGET,
    };
    const expected = {
      source_rows: sourceRows.length,
      unique_source_identities: SOURCE_CANDIDATES,
      matched_directory_rows: plan.updates.length + noops.length + conflicts.length,
      updates: plan.updates.length,
      noops: noops.length,
      conflicts: conflicts.length,
      skipped: skipped.length,
      source_quarantined: 0,
      provenance: plan.provenance.length,
      rollback: rollback.length,
      inserts: 0 as const,
    };
    const source: SbisExactPlanManifest['source'] = {
      id: 'sbis_registry' as const,
      analysis: {
        file_name: 'registry-exact-source-analysis.json',
        sha256: SOURCE_ANALYSIS_SHA256,
        candidates: SOURCE_CANDIDATES,
      },
      locations: {
        file_name: 'source-locations.jsonl',
        sha256: SOURCE_LOCATIONS_SHA256,
        rows: SOURCE_LOCATIONS_ROWS,
      },
      registry_manifest: {
        file_name: 'polza-registry-v2.manifest.json',
        sha256: REGISTRY_MANIFEST_SHA256,
      },
    };
    const summary = {
      dryRunOnly: true,
      mode: 'existing-only-exact-okved-strict-inn-ogrn',
      source,
      reference: REFERENCE,
      snapshot: snapshotMeta,
      target: TARGET,
      combined: expected,
      idempotencyCheck: {
        repeatedUpdates: repeatedEligible.length,
        passed: repeatedEligible.length === 0,
      },
    };
    await Promise.all([
      writeJson(path.join(stage, 'summary.json'), summary),
      ...JSONL_ARTIFACTS.map((name) => writeJsonl(
        path.join(stage, name),
        artifactRows[name],
      )),
    ]);
    const artifacts = Object.fromEntries(await Promise.all([
      (async () => ['summary.json', {
        sha256: await hashFile(path.join(stage, 'summary.json')),
      }] as const)(),
      ...JSONL_ARTIFACTS.map(async (name) => [name, {
        sha256: await hashFile(path.join(stage, name)),
        rows: artifactRows[name].length,
      }] as const),
    ])) as SbisExactPlanManifest['artifacts'];
    const manifest: SbisExactPlanManifest = {
      version: 1,
      plan: 'sbis-exact-okved-v1',
      source,
      reference: REFERENCE,
      snapshot: snapshotMeta,
      target: TARGET,
      artifacts,
      expected,
    };
    await writeJson(path.join(stage, 'manifest.json'), manifest);
    const validated = await processSbisExactPlanFiles({
      planDir: stage,
      manifestPath: path.join(stage, 'manifest.json'),
    });
    if (
      validated.planFingerprint !== buildSbisExactPlanFingerprint(manifest)
      || validated.updateRows !== plan.updates.length
      || validated.conflictRows !== conflicts.length
    ) {
      throw new Error('Published SBIS exact plan failed self-validation');
    }
    await rename(stage, args.out);
    process.stdout.write(`${JSON.stringify({
      dryRunOnly: true,
      out: args.out,
      planFingerprint: buildSbisExactPlanFingerprint(manifest),
      expected,
      decisions: Object.fromEntries(
        [...new Set(decisions.decisions.map((decision) => decision.category))]
          .sort()
          .map((category) => [
            category,
            decisions.decisions.filter((decision) => (
              decision.category === category
            )).length,
          ]),
      ),
      decisionSha256: decisions.decision_sha256,
      snapshotBytes: snapshotStats.size,
    }, null, 2)}\n`);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
