import 'server-only';
import { createHash } from 'node:crypto';
import { buildDomainSnapshot } from './ledger';

type ScoreOrigin = 'api' | 'cache' | 'legacy' | null;
type EmailFact = { address: string | null; validationStatus?: string | null };
export type ClientPipelineDomainSnapshot = ReturnType<typeof buildDomainSnapshot>;

type SnapshotWriteResult = { error: { message?: string } | null };
type SnapshotDatabase = {
  from: (table: string) => {
    upsert: (
      rows: ReadonlyArray<Record<string, unknown>>,
      options: { onConflict: string; ignoreDuplicates: boolean },
    ) => PromiseLike<SnapshotWriteResult>;
  };
};

function ratingFromRaw(raw: Record<string, unknown> | null): string | null {
  if (!raw || !Object.prototype.hasOwnProperty.call(raw, 'rating')) return null;
  const rating = String(raw.rating ?? '').trim();
  return rating || null;
}

export function buildAutoPipelineDomainSnapshot(input: {
  clientUserId: string;
  runId: string;
  employerId: string;
  domain: string | null;
  companyName?: string | null;
  score: number | null;
  spf?: string | null;
  raw?: Record<string, unknown> | null;
  scoreOrigin?: ScoreOrigin;
  primaryEmail?: EmailFact | null;
  additionalEmails?: readonly EmailFact[];
  sourceFilename?: string | null;
  scoredAt: string;
  routedCampaignId?: string | null;
  routedCampaignName?: string | null;
  routedAt?: string | null;
}): ClientPipelineDomainSnapshot {
  const emails: EmailFact[] = [];
  if (input.primaryEmail) emails.push(input.primaryEmail);
  emails.push(...(input.additionalEmails ?? []));
  return buildDomainSnapshot({
    clientUserId: input.clientUserId,
    sourceKind: 'auto_pipeline',
    sourceRunId: input.runId,
    sourceRowId: input.employerId,
    domain: input.domain ?? '',
    companyName: input.companyName,
    score: input.score,
    rating: ratingFromRaw(input.raw ?? null),
    spf: input.spf,
    scoreOrigin: input.scoreOrigin,
    emails,
    sourceFilename: input.sourceFilename,
    scoredAt: input.scoredAt,
    routedCampaignId: input.routedCampaignId,
    routedCampaignName: input.routedCampaignName,
    routedAt: input.routedAt,
  });
}

export function buildManualScoringDomainSnapshot(input: {
  clientUserId: string;
  runId: string;
  rowId: string | number;
  domain: string | null;
  companyName?: string | null;
  score: number | null;
  rating?: string | null;
  spf?: string | null;
  email?: string | null;
  emailValidationStatus?: string | null;
  email2?: string | null;
  email2ValidationStatus?: string | null;
  sourceFilename?: string | null;
  scoredAt: string;
  routedCampaignId?: string | null;
  routedCampaignName?: string | null;
  routedAt?: string | null;
}): ClientPipelineDomainSnapshot {
  return buildDomainSnapshot({
    clientUserId: input.clientUserId,
    sourceKind: 'manual_scoring',
    sourceRunId: input.runId,
    sourceRowId: String(input.rowId),
    domain: input.domain ?? '',
    companyName: input.companyName,
    score: input.score,
    rating: input.rating,
    spf: input.spf,
    emails: [
      { address: input.email ?? null, validationStatus: input.emailValidationStatus },
      { address: input.email2 ?? null, validationStatus: input.email2ValidationStatus },
    ],
    sourceFilename: input.sourceFilename,
    scoredAt: input.scoredAt,
    routedCampaignId: input.routedCampaignId,
    routedCampaignName: input.routedCampaignName,
    routedAt: input.routedAt,
  });
}

export function buildLargeFileDomainSnapshot(input: {
  clientUserId: string;
  jobId: string;
  rowId: string | number;
  domain: string | null;
  score: number | null;
  spf?: string | null;
  raw?: Record<string, unknown> | null;
  scoreOrigin?: ScoreOrigin;
  sourceFilename?: string | null;
  scoredAt: string;
}): ClientPipelineDomainSnapshot {
  return buildDomainSnapshot({
    clientUserId: input.clientUserId,
    sourceKind: 'large_score_file',
    sourceJobId: input.jobId,
    sourceRowId: String(input.rowId),
    domain: input.domain ?? '',
    score: input.score,
    rating: ratingFromRaw(input.raw ?? null),
    spf: input.spf,
    scoreOrigin: input.scoreOrigin,
    sourceFilename: input.sourceFilename,
    scoredAt: input.scoredAt,
  });
}

/**
 * Stable UUID derived from the immutable source identity. A retry therefore
 * becomes INSERT ... ON CONFLICT DO NOTHING and never mutates history.
 */
export function domainSnapshotId(snapshot: ClientPipelineDomainSnapshot): string {
  const hasSourceIdentity = Boolean(
    snapshot.source_run_id || snapshot.source_job_id || snapshot.source_row_id,
  );
  const identity = [
    snapshot.client_user_id,
    snapshot.source_kind,
    snapshot.source_run_id ?? '',
    snapshot.source_job_id ?? '',
    snapshot.source_row_id ?? '',
    snapshot.domain ?? '',
    hasSourceIdentity ? '' : snapshot.scored_at,
  ].join('\u0000');
  const hex = createHash('sha256').update(identity).digest('hex');
  const versioned = `${hex.slice(0, 12)}5${hex.slice(13, 16)}`;
  const variant = `${(parseInt(hex[16], 16) & 0x3 | 0x8).toString(16)}${hex.slice(17, 20)}`;
  return `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${variant}-${hex.slice(20, 32)}`;
}

/** Append immutable snapshots in bounded payloads; invalid domains cannot satisfy the DB contract. */
export async function persistDomainSnapshots(
  db: SnapshotDatabase,
  snapshots: readonly ClientPipelineDomainSnapshot[],
): Promise<number> {
  const rows = snapshots
    .filter((snapshot) => Boolean(snapshot.domain))
    .map((snapshot) => ({ ...snapshot, id: domainSnapshotId(snapshot) }));
  const chunkSize = 500;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const { error } = await db
      .from('client_pipeline_domain_snapshots')
      .upsert(rows.slice(offset, offset + chunkSize), {
        onConflict: 'id',
        ignoreDuplicates: true,
      });
    if (error) throw new Error(error.message || 'Failed to persist client pipeline snapshots');
  }
  return rows.length;
}
