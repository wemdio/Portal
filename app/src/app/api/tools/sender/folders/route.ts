import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { SenderOpError } from '@/lib/sender/campaignOps';
import { listFolders } from '@/lib/sender/folders';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * GET — папки рассылок («Автоаутрич RU», «Автоаутрич EN») с настройками,
 * ящиками и счётчиками: сколько ящиков, сколько из них рабочих, сколько
 * кампаний. Правка настроек — PATCH /api/tools/sender/folders/[id].
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.folders.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    try {
      return NextResponse.json({ folders: await listFolders() });
    } catch (e) {
      if (e instanceof SenderOpError) return jsonError(e.message, e.status);
      throw e;
    }
  });
}
