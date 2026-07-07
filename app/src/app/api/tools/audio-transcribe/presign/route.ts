import { NextRequest, NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { createMainS3UploadUrl } from '@/lib/mainS3Server';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUPPORTED_EXTENSIONS = new Set(['mp3', 'wav', 'mp4', 'avi']);
const MAX_FILE_SIZE_BYTES = 600 * 1024 * 1024;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return '';
  return filename.slice(idx + 1).toLowerCase();
}

/**
 * POST /api/tools/audio-transcribe/presign
 * Body: { filename: string, size?: number, contentType?: string }
 *
 * Отдаёт presigned PUT URL — браузер льёт файл НАПРЯМУЮ в MAIN S3, минуя portal
 * и корпоративные шлюзы (которые режут multipart POST'ы на polza-portal.ru,
 * инцидент 07.07.2026). Клиент дальше:
 *   1) PUT file → uploadUrl
 *   2) POST /api/tools/audio-transcribe { s3Key, filename, jobId }
 *
 * Ключ жёстко привязан к userId — воркер потом не пустит чужой ключ.
 */
export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  let body: { filename?: unknown; size?: unknown; contentType?: unknown };
  try {
    body = (await req.json()) as { filename?: unknown; size?: unknown; contentType?: unknown };
  } catch {
    return jsonError('Невалидный JSON', 400);
  }

  const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
  if (!filename) return jsonError('Не указано имя файла', 400);

  const ext = getExtension(filename);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return jsonError('Неверный формат файла. Поддерживаются: MP3, WAV, MP4, AVI.', 400);
  }

  const size = typeof body.size === 'number' ? body.size : 0;
  if (size > MAX_FILE_SIZE_BYTES) {
    return jsonError('Файл превышает лимит 600 МБ.', 400);
  }

  const contentType =
    typeof body.contentType === 'string' && body.contentType.trim()
      ? body.contentType.trim()
      : 'application/octet-stream';

  // Санитайзим имя: только ASCII-безопасное, чтобы не ловить сюрпризов
  // на стороне S3-URL. Расширение сохраняем — оно уже проверено выше.
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || `audio.${ext}`;
  const s3Key = `audio-transcribe/${user.id}/${crypto.randomUUID()}-${safe}`;

  try {
    const uploadUrl = await createMainS3UploadUrl({
      key: s3Key,
      contentType,
      expiresInSeconds: 60 * 60,
    });
    return NextResponse.json({ ok: true, uploadUrl, s3Key, contentType });
  } catch (err) {
    await logError('audio.transcribe.presign.failed', err, { userId: user.id, filename });
    return jsonError('Не удалось создать ссылку загрузки', 500);
  }
}
