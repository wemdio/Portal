import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Email } from './types';

const TABLE = 'instantly_ownership_evidence_progress';
const SCHEMA_VERSION = 1;
const INCOMPLETE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COMPLETE_TTL_MS = 6 * 60 * 60 * 1000;
export const OWNERSHIP_CHECKPOINT_MAX_BYTES = 2 * 1024 * 1024;
export const OWNERSHIP_CHECKPOINT_MAX_CAMPAIGNS = 64;
export const OWNERSHIP_CHECKPOINT_MAX_PAGES = 2_000;

export interface OwnershipSurfaceProgress {
  cursor: string | null;
  complete: boolean;
  pages: number;
  /** Hashes detect provider cursor cycles without retaining opaque PII tokens. */
  seenCursorHashes: string[];
}

export interface OwnershipCampaignEvidence {
  parents: Array<{ email: Email; score: number }>;
  contextEmails: Email[];
}

export interface OwnershipEvidenceProgress {
  version: 1;
  search: OwnershipSurfaceProgress;
  sent: OwnershipSurfaceProgress;
  evidence: Record<string, OwnershipCampaignEvidence>;
  /** Never turn a truncated proof into complete cross-project evidence. */
  blockedReason?: string;
}

export interface OwnershipEvidenceCheckpoint {
  key: string;
  revision: number;
  progress: OwnershipEvidenceProgress;
}

export function ownershipEvidenceDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function freshProgress(): OwnershipEvidenceProgress {
  const surface = (): OwnershipSurfaceProgress => ({
    cursor: null, complete: false, pages: 0, seenCursorHashes: [],
  });
  return { version: SCHEMA_VERSION, search: surface(), sent: surface(), evidence: {} };
}

function isValidSurface(value: unknown): value is OwnershipSurfaceProgress {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OwnershipSurfaceProgress>;
  return (
    (candidate.cursor === null || typeof candidate.cursor === 'string') &&
    typeof candidate.complete === 'boolean' &&
    Number.isSafeInteger(candidate.pages) && (candidate.pages ?? -1) >= 0 &&
    (candidate.pages ?? Infinity) <= OWNERSHIP_CHECKPOINT_MAX_PAGES &&
    Array.isArray(candidate.seenCursorHashes) &&
    candidate.seenCursorHashes.length <= OWNERSHIP_CHECKPOINT_MAX_PAGES &&
    candidate.seenCursorHashes.every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) &&
    (!candidate.complete || candidate.cursor === null)
  );
}

function isValidProgress(value: unknown): value is OwnershipEvidenceProgress {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OwnershipEvidenceProgress>;
  if (
    candidate.version !== SCHEMA_VERSION ||
    !isValidSurface(candidate.search) || !isValidSurface(candidate.sent) ||
    !candidate.evidence || typeof candidate.evidence !== 'object' ||
    Array.isArray(candidate.evidence) ||
    Object.keys(candidate.evidence).length > OWNERSHIP_CHECKPOINT_MAX_CAMPAIGNS ||
    (candidate.blockedReason !== undefined && typeof candidate.blockedReason !== 'string')
  ) return false;
  return Object.values(candidate.evidence).every((entry) =>
    entry && Array.isArray(entry.parents) && entry.parents.length <= 1 &&
    entry.parents.every((parent) => parent && Number.isFinite(parent.score) && parent.score > 0 &&
      parent.score <= 100 && parent.email && typeof parent.email.id === 'string') &&
    Array.isArray(entry.contextEmails) && entry.contextEmails.length <= 8 &&
    entry.contextEmails.every((email) => email && typeof email.id === 'string'),
  );
}

function storageError(error: { message?: string; code?: string } | null): Error {
  const unavailable = error?.code === '42P01' || error?.code === 'PGRST205';
  return new Error(unavailable
    ? 'ownership evidence checkpoint migration is not available'
    : `ownership evidence checkpoint storage unavailable: ${error?.message ?? 'empty write result'}`);
}

/** The key includes a format version; old/foreign inputs cannot share cursors. */
export async function loadOwnershipEvidenceCheckpoint(
  db: SupabaseClient,
  scope: unknown,
): Promise<OwnershipEvidenceCheckpoint> {
  const key = ownershipEvidenceDigest([SCHEMA_VERSION, scope]);
  const existing = await db.from(TABLE).select('checkpoint_key, revision, progress, expires_at')
    .eq('checkpoint_key', key).maybeSingle();
  if (existing.error) throw storageError(existing.error);
  if (existing.data) {
    const revision = Number(existing.data.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('ownership evidence checkpoint revision is invalid');
    }
    if (Date.parse(existing.data.expires_at ?? '') > Date.now()) {
      if (!isValidProgress(existing.data.progress)) {
        throw new Error('ownership evidence checkpoint data is invalid');
      }
      return { key, revision, progress: existing.data.progress };
    }
    const checkpoint = { key, revision, progress: freshProgress() };
    await saveOwnershipEvidenceCheckpoint(db, checkpoint);
    return checkpoint;
  }
  const progress = freshProgress();
  const now = Date.now();
  const inserted = await db.from(TABLE).insert({
    checkpoint_key: key,
    revision: 0,
    progress,
    expires_at: new Date(now + INCOMPLETE_TTL_MS).toISOString(),
    updated_at: new Date(now).toISOString(),
  }).select('checkpoint_key').maybeSingle();
  // A competing worker won initialization. It owns the next page; do not run
  // an uncheckpointed duplicate scan when the row could not be reserved.
  if (inserted.error || !inserted.data) throw storageError(inserted.error);
  return { key, revision: 0, progress };
}

/** CAS must commit before requesting the next provider page. */
export async function saveOwnershipEvidenceCheckpoint(
  db: SupabaseClient,
  checkpoint: OwnershipEvidenceCheckpoint,
): Promise<void> {
  const serialized = JSON.stringify(checkpoint.progress);
  if (Buffer.byteLength(serialized, 'utf8') > OWNERSHIP_CHECKPOINT_MAX_BYTES) {
    throw new Error('ownership evidence checkpoint payload capacity exceeded');
  }
  if (!isValidProgress(checkpoint.progress)) throw new Error('ownership evidence checkpoint data is invalid');
  const complete = checkpoint.progress.search.complete && checkpoint.progress.sent.complete;
  const now = Date.now();
  const updated = await db.from(TABLE).update({
    revision: checkpoint.revision + 1,
    progress: checkpoint.progress,
    updated_at: new Date(now).toISOString(),
    expires_at: new Date(now + (complete ? COMPLETE_TTL_MS : INCOMPLETE_TTL_MS)).toISOString(),
  }).eq('checkpoint_key', checkpoint.key).eq('revision', checkpoint.revision)
    .select('checkpoint_key').maybeSingle();
  if (updated.error) throw storageError(updated.error);
  if (!updated.data) throw new Error('ownership evidence checkpoint changed concurrently');
  checkpoint.revision += 1;
}
