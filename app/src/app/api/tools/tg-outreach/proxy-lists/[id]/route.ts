import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxy-lists.by-id.put' },
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

      const update: Record<string, unknown> = {};
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return jsonError('name не может быть пустым', 400);
        update.name = name;
      }
      if (Object.keys(update).length === 0) return jsonError('Нет полей для обновления', 400);

      const { data, error } = await auth.supabase
        .from('tg_outreach_proxy_lists')
        .update(update)
        .eq('id', id)
        .select()
        .single();

      if (error) return jsonError(error.message, 500);
      return NextResponse.json(data);
    },
  );
}

/**
 * Удаление списка.
 *
 * on delete set null на FK — прокси не пропадают, а переезжают в виртуальный
 * «Неопределённые». Поэтому подтверждения «удалить вместе с прокси» тут нет:
 * по логике фичи список — это ярлык, а не контейнер.
 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxy-lists.by-id.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { error } = await auth.supabase
        .from('tg_outreach_proxy_lists')
        .delete()
        .eq('id', id);

      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ ok: true });
    },
  );
}
