import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Включить или выключить сразу несколько аккаунтов кампании.
 *
 * Партию заливают выключенной — три десятка аккаунтов, — и переключатель
 * «Активен» приходилось жать в каждой строке. Правила те же, что у одиночного
 * PUT /accounts/[id]: архивный аккаунт не включается, иначе он ушёл бы в
 * рассылку, оставаясь невидимым в списке кампании. Такие строки молча
 * пропускаются, а не валят всю пачку; сколько реально изменилось — в ответе.
 */
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.bulk-active.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      let body: { ids?: unknown; is_active?: unknown };
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      const ids = Array.isArray(body.ids)
        ? body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (ids.length === 0) return jsonError('ids должен быть непустым массивом', 400);
      if (typeof body.is_active !== 'boolean') return jsonError('is_active должен быть true или false', 400);
      const isActive = body.is_active;

      // Через клиент пользователя: RLS сама отсечёт чужие кампании.
      let query = auth.supabase
        .from('tg_outreach_accounts')
        .update({ is_active: isActive })
        .in('id', ids);
      if (isActive) query = query.is('archived_at', null);
      const { data, error } = await query.select('id');

      if (error) return jsonError(error.message, 500);
      const updatedIds = (data ?? []).map((row) => (row as { id: string }).id);
      return NextResponse.json({
        updated: updatedIds.length,
        skipped: ids.length - updatedIds.length,
        ids: updatedIds,
        is_active: isActive,
      });
    },
  );
}
