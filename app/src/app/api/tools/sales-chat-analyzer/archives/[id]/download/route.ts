/**
 * Скачивание готового ZIP-архива sales-chat диалогов аккаунта.
 *
 * Принимает id архивного задания (sales_chat_archive_jobs.id). Если задание в
 * статусе `done` и архив не старше 7 дней — выдаёт presigned-ссылку на S3
 * (через MAIN S3 bucket). UI получает JSON и сам триггерит скачивание —
 * это позволяет показать ошибку, не прерывая загрузку «через себя».
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireSalesChatAccess } from '@/lib/salesChatAnalyzer/apiGuard';
import { createMainS3DownloadUrl } from '@/lib/mainS3Server';
import { sanitizeFilename } from '@/lib/salesChatAnalyzer/dialogDocx';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TTL_DAYS = 7;
const TTL_SECONDS = 60 * 60 * 24 * TTL_DAYS;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return jsonError(guard.error, guard.status);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  const { data: job, error } = await supabaseAdmin!
    .from('sales_chat_archive_jobs')
    .select('id,account_id,status,s3_key,file_size_bytes,finished_at')
    .eq('id', id)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!job) return jsonError('Задание не найдено.', 404);
  if (job.status !== 'done' || !job.s3_key) {
    return jsonError('Архив ещё не готов.', 409);
  }

  // Файл стираем не сами; presigned URL живёт TTL_DAYS суток, и если архив
  // моложе — отдаём свежий URL. Если старше — UI должен предложить пересобрать.
  if (job.finished_at) {
    const ageMs = Date.now() - new Date(job.finished_at).getTime();
    if (ageMs > TTL_SECONDS * 1000) {
      return jsonError('Срок действия архива истёк. Пересоберите архив.', 410);
    }
  }

  // Берём peer-агрегат для имени файла (компания/менеджер, дата). Не критично
  // если нет — fallback на job id.
  const { data: acc } = await supabaseAdmin!
    .from('sales_chat_accounts')
    .select('label, phone')
    .eq('id', job.account_id)
    .maybeSingle();

  const accLabel = acc?.label?.trim() || acc?.phone || 'account';
  const dateStr = (job.finished_at ?? new Date().toISOString()).slice(0, 10);
  const filename = sanitizeFilename(`Архив переписок · ${accLabel} · ${dateStr}.zip`);

  let url: string;
  try {
    url = await createMainS3DownloadUrl({
      key: job.s3_key,
      expiresInSeconds: TTL_SECONDS,
      downloadFilename: filename,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError(`S3: ${message}`, 500);
  }

  return NextResponse.json({
    url,
    filename,
    file_size_bytes: job.file_size_bytes,
  });
}
