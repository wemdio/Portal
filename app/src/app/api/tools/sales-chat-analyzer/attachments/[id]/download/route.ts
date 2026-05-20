import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireSalesChatAccess } from '@/lib/salesChatAnalyzer/apiGuard';
import { getMainS3ObjectBuffer } from '@/lib/mainS3Server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function contentDispositionFilename(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return jsonError(guard.error, guard.status);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  const { data: attachment, error } = await supabaseAdmin!
    .from('sales_chat_message_attachments')
    .select('id,file_name,mime_type,s3_key,status,error_message')
    .eq('id', id)
    .single();

  if (error) return jsonError(error.message, error.code === 'PGRST116' ? 404 : 500);
  if (attachment.status !== 'uploaded' || !attachment.s3_key) {
    return jsonError(attachment.error_message ?? 'Файл еще не выгружен в S3', 409);
  }

  const buffer = await getMainS3ObjectBuffer(attachment.s3_key);
  if (!buffer) return jsonError('Файл не найден в S3', 404);

  const filename = attachment.file_name || `attachment-${attachment.id}`;
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': attachment.mime_type || 'application/octet-stream',
      'Content-Length': String(buffer.length),
      'Content-Disposition': contentDispositionFilename(filename),
    },
  });
}
