import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { createAvatarUploadUrl } from '@/lib/s3Server';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

function extFromContentType(contentType: string): string | null {
  const ct = contentType.toLowerCase();
  if (ct === 'image/png') return 'png';
  if (ct === 'image/jpeg') return 'jpg';
  if (ct === 'image/webp') return 'webp';
  if (ct === 'image/gif') return 'gif';
  return null;
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };

  const text = await req.text().catch(() => '');
  const body = safeJsonParse<{ contentType?: unknown; ext?: unknown }>(text);
  const contentType = typeof body?.contentType === 'string' ? body.contentType.trim() : '';
  const extRaw = typeof body?.ext === 'string' ? body.ext.trim() : '';

  if (!contentType) return jsonError('Missing contentType', 400);

  const extByCt = extFromContentType(contentType);
  const ext = (extRaw || extByCt || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!ext || !ALLOWED_EXT.has(ext)) return jsonError('Unsupported file type', 400);

  try {
    const result = await createAvatarUploadUrl({
      userId: user.id,
      contentType,
      ext,
    });

    await logAudit('profile.avatar.presign.success', 'Presigned avatar upload url created', { key: result.key }, logMeta);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await logError('profile.avatar.presign.failed', err, { contentType, ext }, logMeta);
    return jsonError('Failed to create upload url', 500);
  }
}

