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

/**
 * Supabase Storage (на бэке Go) валидирует ключ объектов через `\w` — это
 * только `[A-Za-z0-9_]`, без юникода. Кириллица в ключе ломает upload
 * с ошибкой "Invalid key". Поэтому имя файла для STORAGE_KEY мы
 * транслитерируем (а исходное имя сохраняем отдельно в `brief_file_name`
 * для отображения).
 */
const RU_TRANSLITERATION: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'E', Ж: 'Zh',
  З: 'Z', И: 'I', Й: 'Y', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O',
  П: 'P', Р: 'R', С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'Kh', Ц: 'Ts',
  Ч: 'Ch', Ш: 'Sh', Щ: 'Sch', Ъ: '', Ы: 'Y', Ь: '', Э: 'E', Ю: 'Yu', Я: 'Ya',
};

function transliterateRu(input: string): string {
  let out = '';
  for (const ch of input) {
    out += RU_TRANSLITERATION[ch] ?? ch;
  }
  return out;
}

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

  // sanitise base for an S3-compatible Supabase Storage key (ASCII only):
  // 1) транслитерируем кириллицу, 2) пробелы/_ → дефис, 3) выкидываем всё, что
  // не [A-Za-z0-9-], 4) схлопываем дубли дефисов.
  const transliterated = transliterateRu(base);
  const safeBase = transliterated
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
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
