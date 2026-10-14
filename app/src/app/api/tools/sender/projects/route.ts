import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** Проекты, к которым сейчас привязывают кампании, — как в остальных списках портала. */
const ACTIVE_STATUSES = new Set(['В работе', 'Тестирование', 'Подготовка']);

/**
 * GET — проекты портала для привязки кампании «Рассылки».
 *
 * Отдаём все, а не только активные: открытая кампания может быть привязана к
 * проекту, который уже на паузе или завершён, — без него в списке выбор
 * показал бы «без проекта». Активные экран ставит первыми.
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.projects.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('id, client, name, status')
      .order('client', { ascending: true, nullsFirst: false });
    if (error) return jsonError(error.message, 500);

    return NextResponse.json({
      projects: (data ?? []).map((row) => ({
        id: String(row.id),
        label: String(row.client || row.name || 'Без названия'),
        active: ACTIVE_STATUSES.has(String(row.status)),
      })),
    });
  });
}
