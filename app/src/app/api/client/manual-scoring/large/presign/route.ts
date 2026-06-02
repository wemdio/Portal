import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { createMainS3UploadUrl } from '@/lib/mainS3Server';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/client/manual-scoring/large/presign
 * Body: { filename: string, contentType?: string }
 *
 * Возвращает presigned PUT URL — браузер заливает большой файл доменов
 * НАПРЯМУЮ в S3 (минуя лимит размера тела роута Next). Тот же механизм, что
 * у аватарок/картинок задач. Ключ привязан к userId (анти-spoofing на шаге
 * создания джоба).
 */
export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId } = result.auth;

  let body: { filename?: unknown; contentType?: unknown };
  try {
    body = (await req.json()) as { filename?: unknown; contentType?: unknown };
  } catch {
    return jsonError('Невалидный JSON', 400);
  }

  const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
  const contentType =
    typeof body.contentType === 'string' && body.contentType.trim()
      ? body.contentType.trim()
      : 'text/plain';
  if (!filename) return jsonError('Не указано имя файла', 400);

  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'domains.txt';
  const key = `large-score/${userId}/${crypto.randomUUID()}-${safe}`;

  try {
    const uploadUrl = await createMainS3UploadUrl({ key, contentType, expiresInSeconds: 60 * 60 });
    return NextResponse.json({ ok: true, uploadUrl, key, contentType });
  } catch (err) {
    await logError('client.manual-scoring.large.presign.failed', err, { userId });
    return jsonError('Не удалось создать ссылку загрузки', 500);
  }
}
