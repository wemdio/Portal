/**
 * Вернуть отложенные контакты базы в очередь.
 *
 * Контакт, три раза подряд не прошедший отправку, уходит в `failed` и больше не
 * выбирается: иначе мусорная строка в начале файла заткнула бы всю базу. Но
 * часть причин снимается настройкой, а не правкой файла — порог длины первого
 * сообщения ровно такой. Подняли порог — контакты обязаны вернуться в работу,
 * иначе настройка помогает только базам, загруженным после неё.
 *
 * Возвращаем только `failed`. `skipped` — терминальные и по другим причинам
 * (юзернейма нет в Telegram, этому человеку уже писали), их возврат означал бы
 * повторную отправку тому же человеку.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.requeue.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: base } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id')
        .eq('id', id)
        .maybeSingle();
      if (!base) return jsonError('База не найдена', 404);

      // attempts обнуляем вместе со статусом: иначе контакт вернётся в очередь с
      // тремя попытками за спиной и сгорит на первом же сетевом сбое.
      const { data, error } = await auth.supabase
        .from('tg_outreach_base_contacts')
        .update({
          status: 'pending',
          attempts: 0,
          skip_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq('base_id', id)
        .eq('status', 'failed')
        .select('id');
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ ok: true, requeued: (data ?? []).length });
    },
  );
}
