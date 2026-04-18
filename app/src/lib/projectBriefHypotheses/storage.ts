/**
 * Storage helpers for project brief PDFs in Supabase Storage.
 *
 * Layout inside the `briefs` bucket: `projects/{sanitizedProjectId}/{ts}-{sanitizedFileName}`.
 * Both segments are sanitised so we never trust user-provided text in storage paths.
 */

export const BRIEF_BUCKET =
  process.env.NEXT_PUBLIC_BRIEF_STORAGE_BUCKET ?? process.env.BRIEF_STORAGE_BUCKET ?? 'briefs';

export const BRIEF_PROJECTS_PREFIX = 'projects';

const MAX_FILE_NAME_LENGTH = 120;
const MAX_PROJECT_ID_LENGTH = 64;
const DEFAULT_FILE_BASE = 'brief';

/** Strip path-traversal and slashes from a single project id segment. */
export function sanitizeProjectIdForPath(projectId: string): string {
  const trimmed = String(projectId ?? '').trim();
  if (!trimmed) return 'unknown';

  const safe = trimmed
    // strip path separators
    .replace(/[\\/]+/g, '')
    // strip dot-runs to kill traversal
    .replace(/\.{2,}/g, '')
    // keep only ASCII letters/digits, hyphen, underscore
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, MAX_PROJECT_ID_LENGTH);

  return safe.length > 0 ? safe : 'unknown';
}

/** Produce a safe `*.pdf` filename, preserving Cyrillic letters. */
export function sanitizeBriefFileName(rawName: string): string {
  const trimmed = String(rawName ?? '').trim();

  // strip directory parts
  const lastPart = trimmed.split(/[\\/]+/).pop() ?? '';

  // remove dot-runs (path traversal) but keep the final extension
  const noTraversal = lastPart.replace(/\.{2,}/g, '');

  // split base / extension
  const lower = noTraversal.toLowerCase();
  const hasPdfExt = lower.endsWith('.pdf');
  const base = hasPdfExt ? noTraversal.slice(0, -4) : noTraversal;

  // sanitise base: collapse whitespace and unsafe chars to hyphen, keep cyrillic + ascii word chars
  const safeBase = base
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}\-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  const finalBase = safeBase.length > 0 ? safeBase : DEFAULT_FILE_BASE;

  const maxBaseLen = MAX_FILE_NAME_LENGTH - '.pdf'.length;
  const truncated = finalBase.slice(0, maxBaseLen);

  return `${truncated}.pdf`;
}

export interface BuildBriefStoragePathInput {
  projectId: string;
  fileName: string;
  timestamp?: number;
}

/** Build the canonical storage path for a project brief. */
export function buildBriefStoragePath({
  projectId,
  fileName,
  timestamp,
}: BuildBriefStoragePathInput): string {
  const safeProjectId = sanitizeProjectIdForPath(projectId);
  const safeFileName = sanitizeBriefFileName(fileName);
  const ts = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now();
  return `${BRIEF_PROJECTS_PREFIX}/${safeProjectId}/${ts}-${safeFileName}`;
}

/** True when a Supabase Storage path looks like one of our project briefs. */
export function isProjectBriefPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return path.startsWith(`${BRIEF_PROJECTS_PREFIX}/`);
}
