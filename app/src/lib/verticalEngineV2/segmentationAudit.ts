/**
 * Чистые хелперы предзапускного аудита сегментации Vertical Engine v2.
 *
 * Один контракт готовит точную аудиторию запуска, строит объяснимый отчёт и
 * те же группы лидов, которые затем материализуются в кампании. Благодаря
 * этому строки, исключённые quality/email-гейтами, не искажают распределение,
 * а неполная LLM-классификация не маскируется под default.
 */

import { createHash } from 'node:crypto';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import type { VeChainLetter, VeOperatorMapping } from './types';
import type { DetailedSegmentClassificationResult } from './segmentClassify';
import { mapBaseRowsToLeads } from './launchHandoff';

export interface SegmentationAuditExcluded {
  lowRelevance: number;
  invalidEmailStatus: number;
  invalidEmail: number;
  duplicateEmail: number;
}

export interface PreparedSegmentationAudience {
  totalRows: number;
  /** Строки ровно в порядке leads; именно их получает классификатор. */
  rows: Array<Record<string, unknown>>;
  leads: LeadCreatePayload[];
  /** Индекс каждой launchable-строки в исходном ve_bases.data. */
  originalRowIndices: number[];
  /** Человекочитаемые подписи, параллельные rows/leads. */
  labels: string[];
  excluded: SegmentationAuditExcluded;
}

export interface PrepareSegmentationAudienceInput {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  source?: string | null;
  operatorMapping?: VeOperatorMapping[];
}

export interface SegmentationAuditExample {
  rowIndex: number;
  label: string;
  email: string;
}

export interface SegmentationAuditBucket {
  count: number;
  sharePct: number;
  examples: SegmentationAuditExample[];
}

export interface SegmentationAuditSegment extends SegmentationAuditBucket {
  when: string;
}

export type SegmentationAuditStatus = 'complete' | 'incomplete' | 'not_required';

export interface SegmentationAuditReport {
  status: SegmentationAuditStatus;
  templateId: string;
  baseId: string;
  totalRows: number;
  launchableRows: number;
  excluded: SegmentationAuditExcluded;
  segments: SegmentationAuditSegment[];
  default: SegmentationAuditBucket;
  unclassifiedCount: number;
  unclassifiedRows: number[];
  failedBatches: number;
  totalBatches: number;
  usage: { tokensUsed: number; costUsd: number };
  inputHash: string;
}

export interface BuildSegmentationAuditInput {
  templateId: string;
  baseId: string;
  segments: string[];
  audience: PreparedSegmentationAudience;
  classification: DetailedSegmentClassificationResult;
}

export interface SegmentationLaunchGroup {
  segment: string | null;
  leadIndices: number[];
}

/** Условия `when` всех писем: trim + case-insensitive dedup, первое написание. */
export function collectSegmentationConditions(letters: VeChainLetter[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const letter of letters) {
    for (const variant of letter.segment_variants ?? []) {
      const when = (variant.when ?? '').trim();
      if (!when) continue;
      const key = when.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(when);
    }
  }
  return result;
}

function canonicalSegments(segments: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of segments) {
    const segment = raw.trim();
    if (!segment) continue;
    const key = segment.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(segment);
  }
  return result;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function rowLabel(
  row: Record<string, unknown>,
  operatorMapping: VeOperatorMapping[],
  email: string,
): string {
  for (const mapping of operatorMapping) {
    if (!mapping.matched || !mapping.column) continue;
    const operator = mapping.operator.trim().toLowerCase();
    if (operator !== 'companyname' && operator !== 'company') continue;
    const value = stringifyCell(row[mapping.column]);
    if (value) return value;
  }
  for (const candidate of ['companyname', 'company', 'компания']) {
    for (const [column, raw] of Object.entries(row)) {
      if (column.toLowerCase() !== candidate) continue;
      const value = stringifyCell(raw);
      if (value) return value;
    }
  }
  return email;
}

/**
 * Применяет ровно launch-гейты к строкам базы и сохраняет сверку причин.
 * Служебные quality-поля действуют только для source='auto'.
 */
export function prepareSegmentationAudience(
  input: PrepareSegmentationAudienceInput,
): PreparedSegmentationAudience {
  const { rows, columns, source, operatorMapping = [] } = input;
  const excluded: SegmentationAuditExcluded = {
    lowRelevance: 0,
    invalidEmailStatus: 0,
    invalidEmail: 0,
    duplicateEmail: 0,
  };

  const qualityRows: Array<{ row: Record<string, unknown>; originalIndex: number }> = [];
  rows.forEach((row, originalIndex) => {
    if (source === 'auto') {
      if (row._low_relevance === true) {
        excluded.lowRelevance += 1;
        return;
      }
      const emailStatus = typeof row._email_status === 'string' ? row._email_status : null;
      if (emailStatus && emailStatus !== 'ok') {
        excluded.invalidEmailStatus += 1;
        return;
      }
    }
    qualityRows.push({ row, originalIndex });
  });

  const mapped = mapBaseRowsToLeads({
    rows: qualityRows.map((entry) => entry.row),
    columns,
    operatorMapping,
  });
  const launchablePositions = new Set(mapped.leadRowIndices);
  const keptEmails = new Set(mapped.leads.map((lead) => lead.email.toLowerCase()));

  qualityRows.forEach((entry, position) => {
    if (launchablePositions.has(position)) return;
    const rawEmail = mapped.emailColumn
      ? stringifyCell(entry.row[mapped.emailColumn]).toLowerCase()
      : '';
    if (rawEmail && keptEmails.has(rawEmail)) excluded.duplicateEmail += 1;
    else excluded.invalidEmail += 1;
  });

  const launchRows = mapped.leadRowIndices.map((position) => qualityRows[position]?.row ?? {});
  const originalRowIndices = mapped.leadRowIndices.map(
    (position) => qualityRows[position]?.originalIndex ?? position,
  );
  const labels = launchRows.map((row, index) =>
    rowLabel(row, operatorMapping, mapped.leads[index]?.email ?? ''),
  );

  return {
    totalRows: rows.length,
    rows: launchRows,
    leads: mapped.leads,
    originalRowIndices,
    labels,
    excluded,
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalJsonValue(item)));
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      result[key] = canonicalJsonValue(source[key]);
    }
    return result;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

/** SHA-256 входа и точного расклада; порядок вставки Map не влияет. */
export function computeSegmentationAuditHash(input: {
  templateId: string;
  baseId: string;
  segments: string[];
  audience: PreparedSegmentationAudience;
  assignments: Map<number, string | null>;
}): string {
  const assignments = [...input.assignments.entries()].sort(([left], [right]) => left - right);
  const payload = {
    templateId: input.templateId,
    baseId: input.baseId,
    segments: canonicalSegments(input.segments),
    audience: {
      totalRows: input.audience.totalRows,
      rows: input.audience.rows,
      leads: input.audience.leads,
      originalRowIndices: input.audience.originalRowIndices,
      excluded: input.audience.excluded,
    },
    assignments,
  };
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

function sharePct(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 10_000) / 100;
}

function exampleAt(
  audience: PreparedSegmentationAudience,
  leadIndex: number,
): SegmentationAuditExample {
  return {
    rowIndex: audience.originalRowIndices[leadIndex] ?? leadIndex,
    label: audience.labels[leadIndex] ?? audience.leads[leadIndex]?.email ?? `Строка ${leadIndex + 1}`,
    email: audience.leads[leadIndex]?.email ?? '',
  };
}

/** Объяснимое распределение всех launchable-строк, включая нулевые сегменты. */
export function buildSegmentationAudit(
  input: BuildSegmentationAuditInput,
): SegmentationAuditReport {
  const segments = canonicalSegments(input.segments);
  const canonicalByKey = new Map(segments.map((segment) => [segment.toLowerCase(), segment]));
  const counts = new Map(segments.map((segment) => [segment, 0]));
  const examples = new Map(segments.map((segment) => [segment, [] as SegmentationAuditExample[]]));
  const unclassified = new Set(
    input.classification.unclassifiedRows.filter(
      (row) => Number.isInteger(row) && row >= 0 && row < input.audience.leads.length,
    ),
  );
  let defaultCount = 0;
  const defaultExamples: SegmentationAuditExample[] = [];

  for (let leadIndex = 0; leadIndex < input.audience.leads.length; leadIndex += 1) {
    if (!input.classification.assignments.has(leadIndex)) {
      unclassified.add(leadIndex);
      continue;
    }
    if (unclassified.has(leadIndex)) continue;
    const assignment = input.classification.assignments.get(leadIndex) ?? null;
    if (assignment === null) {
      defaultCount += 1;
      if (defaultExamples.length < 3) defaultExamples.push(exampleAt(input.audience, leadIndex));
      continue;
    }
    const segment = canonicalByKey.get(assignment.trim().toLowerCase());
    if (!segment) {
      unclassified.add(leadIndex);
      continue;
    }
    counts.set(segment, (counts.get(segment) ?? 0) + 1);
    const bucketExamples = examples.get(segment) ?? [];
    if (bucketExamples.length < 3) bucketExamples.push(exampleAt(input.audience, leadIndex));
    examples.set(segment, bucketExamples);
  }

  const total = input.audience.leads.length;
  const unclassifiedRows = [...unclassified].sort((left, right) => left - right);
  return {
    status:
      segments.length === 0
        ? 'not_required'
        : unclassifiedRows.length > 0
          ? 'incomplete'
          : 'complete',
    templateId: input.templateId,
    baseId: input.baseId,
    totalRows: input.audience.totalRows,
    launchableRows: total,
    excluded: { ...input.audience.excluded },
    segments: segments.map((when) => ({
      when,
      count: counts.get(when) ?? 0,
      sharePct: sharePct(counts.get(when) ?? 0, total),
      examples: examples.get(when) ?? [],
    })),
    default: {
      count: defaultCount,
      sharePct: sharePct(defaultCount, total),
      examples: defaultExamples,
    },
    unclassifiedCount: unclassifiedRows.length,
    unclassifiedRows,
    failedBatches: input.classification.failedBatches,
    totalBatches: input.classification.totalBatches,
    usage: { ...input.classification.usage },
    inputHash: computeSegmentationAuditHash({
      templateId: input.templateId,
      baseId: input.baseId,
      segments,
      audience: input.audience,
      assignments: input.classification.assignments,
    }),
  };
}

/**
 * Тот же расклад для запуска. Неполный результат — жёсткая ошибка: такой
 * аудит нельзя подтверждать и превращать в кампании.
 */
export function buildSegmentationLaunchGroups(input: {
  segments: string[];
  leadCount: number;
  classification: DetailedSegmentClassificationResult;
}): SegmentationLaunchGroup[] {
  const segments = canonicalSegments(input.segments);
  const canonicalByKey = new Map(segments.map((segment) => [segment.toLowerCase(), segment]));
  if (input.classification.unclassifiedRows.length > 0) {
    throw new Error('Segmentation classification is incomplete');
  }

  const defaultIndices: number[] = [];
  const bySegment = new Map(segments.map((segment) => [segment, [] as number[]]));
  for (let leadIndex = 0; leadIndex < input.leadCount; leadIndex += 1) {
    if (!input.classification.assignments.has(leadIndex)) {
      throw new Error('Segmentation classification is incomplete');
    }
    const assignment = input.classification.assignments.get(leadIndex) ?? null;
    if (assignment === null) {
      defaultIndices.push(leadIndex);
      continue;
    }
    const segment = canonicalByKey.get(assignment.trim().toLowerCase());
    if (!segment) throw new Error('Segmentation classification is incomplete');
    bySegment.get(segment)?.push(leadIndex);
  }

  const groups: SegmentationLaunchGroup[] = [];
  if (defaultIndices.length > 0) groups.push({ segment: null, leadIndices: defaultIndices });
  for (const segment of segments) {
    const leadIndices = bySegment.get(segment) ?? [];
    if (leadIndices.length > 0) groups.push({ segment, leadIndices });
  }
  return groups;
}
