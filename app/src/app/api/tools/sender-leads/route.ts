import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import {
  EMPTY_COUNTS,
  HISTORY_PAGE_SIZE,
  findFolderByKey,
  loadLeadHistory,
  parseFolderKey,
  parseHistoryFilter,
  type LeadHistoryDto,
} from '@/lib/senderLeads/history';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * GET — история квалификации ответов папки автоаутрича и счётчики по ней.
 *
 * ?folder=auto_en&filter=all|lead|sent|not_lead|pending|error&page=1
 *
 * Живёт под /api/tools/sender-leads, а не под /api/tools/sender: правки
 * в том пути передеплоивают почтовые хосты «Рассылки».
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.senderLeads.history' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const url = new URL(req.url);
    const key = parseFolderKey(url.searchParams.get('folder'));
    if (!key) return jsonError('Не указана папка', 400);
    const filter = parseHistoryFilter(url.searchParams.get('filter'));
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);

    const folder = await findFolderByKey(supabaseAdmin, key);
    if (!folder) {
      const empty: LeadHistoryDto = {
        folderExists: false,
        rows: [],
        total: 0,
        pageSize: HISTORY_PAGE_SIZE,
        counts: EMPTY_COUNTS,
      };
      return NextResponse.json(empty);
    }

    const history = await loadLeadHistory(supabaseAdmin, folder.id, filter, page);
    const body: LeadHistoryDto = { folderExists: true, ...history };
    return NextResponse.json(body);
  });
}
