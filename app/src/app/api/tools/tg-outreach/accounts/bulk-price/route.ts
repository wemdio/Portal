import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Проставить цену сразу нескольким аккаунтам кампании.
 *
 * Партию покупают одним чеком, а цена нужна поштучно — без этой ручки оператор
 * правил бы полсотни строк по одной. Отдельный роут, а не поле в существующем
 * bulk: тот создаёт аккаунты, а этот меняет уже загруженные.
 *
 * `price: null` — стереть цену. Это не то же самое, что ноль: ноль означает
 * «достался бесплатно» и попадает в сумму партии, null — «неизвестно» и не
 * попадает (см. миграцию 20260910_0001).
 */
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.bulk-price.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      let body: { ids?: unknown; price?: unknown };
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      const ids = Array.isArray(body.ids)
        ? body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (ids.length === 0) return jsonError('ids должен быть непустым массивом', 400);

      let price: number | null;
      if (body.price === null || body.price === undefined || body.price === '') {
        price = null;
      } else {
        const parsed = Number(String(body.price).replace(',', '.'));
        if (!Number.isFinite(parsed) || parsed < 0) return jsonError('price должен быть числом ≥ 0', 400);
        price = parsed;
      }

      // Обновляем через клиент пользователя, а не сервисным ключом: RLS сама
      // отсечёт чужие кампании, и отдельная проверка владения не нужна.
      const { data, error } = await auth.supabase
        .from('tg_outreach_accounts')
        .update({ price })
        .in('id', ids)
        .select('id');

      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ updated: data?.length ?? 0, price });
    },
  );
}
