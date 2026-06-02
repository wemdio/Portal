import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { mainS3ObjectExists } from '@/lib/mainS3Server';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/client/manual-scoring/large
 * Body: { s3_key: string, filename: string }
 *
 * Создаёт large_score_jobs после того как браузер залил файл в S3 (presign).
 * Воркер portal-worker-bob-scorer подхватит джоб: спарсит файл → очередь →
 * скоринг в общий резерв. Активные домены потом капают в кампании через
 * ночной добор (daily_limit).
 */
export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId } = result.auth;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  let body: { s3_key?: unknown; filename?: unknown };
  try {
    body = (await req.json()) as { s3_key?: unknown; filename?: unknown };
  } catch {
    return jsonError('Невалидный JSON', 400);
  }

  const s3Key = typeof body.s3_key === 'string' ? body.s3_key.trim() : '';
  const filename = typeof body.filename === 'string' ? body.filename.trim() : 'file';
  // Ключ обязан принадлежать этому клиенту (анти-spoofing).
  if (!s3Key || !s3Key.startsWith(`large-score/${userId}/`)) {
    return jsonError('Неверный ключ файла', 400);
  }

  // Файл реально загружен в S3?
  const exists = await mainS3ObjectExists(s3Key).catch(() => false);
  if (!exists) return jsonError('Файл не найден в хранилище — загрузка не завершилась', 400);

  const { data, error } = await supabaseAdmin
    .from('large_score_jobs')
    .insert({
      client_user_id: userId,
      source_filename: filename.slice(0, 200),
      s3_key: s3Key,
      status: 'parsing',
    })
    .select('id')
    .single();

  if (error || !data) {
    await logError('client.manual-scoring.large.create.failed', error, { userId, s3Key });
    return jsonError('Не удалось создать задачу', 500);
  }

  const jobId = (data as { id: string }).id;
  void logAudit('client.manual-scoring.large.created', 'Large score job created', { jobId, filename }, { userId });
  return NextResponse.json({ ok: true, jobId });
}

/**
 * GET /api/client/manual-scoring/large
 * Список джобов клиента (для карточек прогресса на странице «Ручная обработка»).
 */
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId } = result.auth;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { data, error } = await supabaseAdmin
    .from('large_score_jobs')
    .select(
      'id, source_filename, status, total_domains, parsed_domains, scored_domains, active_domains, cached_domains, junk_domains, error_message, created_at, finished_at',
    )
    .eq('client_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    await logError('client.manual-scoring.large.list.failed', error, { userId });
    return jsonError('Не удалось загрузить задачи', 500);
  }

  return NextResponse.json({ jobs: data ?? [] });
}
