import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { syncInstantlyMailboxNames } from '@/lib/sender/instantlyNameSync';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Только явное обновление страницы. Обычный GET и опрос статусов не пишут имена. */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.sync-names' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const body: unknown = await req.json().catch(() => null);
    const ids = body && typeof body === 'object' && 'mailboxIds' in body ? body.mailboxIds : null;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100
      || ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
      return jsonError('Передайте от 1 до 100 идентификаторов ящиков', 400);
    }

    try {
      const result = await syncInstantlyMailboxNames({ db: supabaseAdmin, mailboxIds: [...new Set(ids)] });
      return NextResponse.json(result);
    } catch {
      return jsonError('Не удалось синхронизировать имена из Instantly. Попробуйте позже.', 502);
    }
  });
}
