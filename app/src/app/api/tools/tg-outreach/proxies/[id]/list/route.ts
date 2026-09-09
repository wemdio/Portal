import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Переместить один прокси в список.
 *
 * body: { list_id: string | null }
 *  - uuid: положить в конкретный список
 *  - null: выкинуть в «Неопределённые»
 *
 * Отдельный endpoint, а не PUT /proxies/[id] с полем proxy_list_id — потому
 * что «положить в список» и «выкинуть из списка» это два разных сценария с
 * двумя разными UI-кнопками, и смешивать их в одном теле запроса неудобно
 * отслеживать по логам.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxies.by-id.list.put' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      if (!('list_id' in body)) return jsonError('list_id обязателен', 400);
      const raw = body.list_id;
      if (raw !== null && typeof raw !== 'string') {
        return jsonError('list_id должен быть uuid или null', 400);
      }

      const update: Record<string, unknown> = { proxy_list_id: raw };

      const { data, error } = await auth.supabase
        .from('tg_outreach_proxies')
        .update(update)
        .eq('id', id)
        .select()
        .single();

      if (error) return jsonError(error.message, 500);
      return NextResponse.json(data);
    },
  );
}
