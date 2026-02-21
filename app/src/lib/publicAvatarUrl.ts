export function normalizePublicAvatarUrl(value: string | null | undefined): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;

  // Supabase Storage S3 protocol uses `<ref>.storage.supabase.co` endpoint,
  // while public object URLs are served from `<ref>.supabase.co`.
  const normalized = raw.replace(
    /^(https?:\/\/)([^/]+)\.storage\.supabase\.co(\/storage\/v1\/object\/public\/)/i,
    '$1$2.supabase.co$3',
  );

  return normalized;
}

