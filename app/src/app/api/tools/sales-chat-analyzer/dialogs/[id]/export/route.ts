import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireSalesChatAccess } from '@/lib/salesChatAnalyzer/apiGuard';
import {
  buildDialogDocx,
  fetchDialogAttachments,
  fetchDialogMessages,
  sanitizeFilename,
  type DialogRow,
} from '@/lib/salesChatAnalyzer/dialogDocx';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return jsonError(guard.error, guard.status);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  const format = (req.nextUrl.searchParams.get('format') ?? 'docx').toLowerCase();
  if (format !== 'docx') return jsonError('Поддерживается только формат docx.', 400);

  const { data: dialog, error } = await supabaseAdmin!
    .from('sales_chat_dialogs')
    .select('id,tg_peer_id,peer_title,peer_username')
    .eq('id', id)
    .single();
  if (error) return jsonError(error.message, error.code === 'PGRST116' ? 404 : 500);

  try {
    const [messages, attachments] = await Promise.all([
      fetchDialogMessages(supabaseAdmin!, id),
      fetchDialogAttachments(supabaseAdmin!, id),
    ]);
    const buffer = await buildDialogDocx({ dialog: dialog as DialogRow, messages, attachments });
    const baseName = sanitizeFilename(`Переписка ${dialog.peer_title ?? dialog.tg_peer_id}`);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(baseName + '.docx')}`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError(message, 500);
  }
}
