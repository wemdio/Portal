import { randomUUID } from 'crypto';

export function getFilenameExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return '';
  return filename.slice(idx).toLowerCase();
}

/**
 * Object name for cis-lead-imports bucket: UUID + extension only.
 * Original filenames (Cyrillic, spaces, parentheses) can trigger Supabase Storage "Invalid key".
 */
export function buildCisLeadImportObjectName(
  originalFilename: string,
  uniqueId: string = randomUUID(),
): string {
  const ext = getFilenameExtension(originalFilename);
  return `${uniqueId}${ext}`;
}
