import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import { queueManualSeedProbes } from '@/lib/sender/seedBoxes';

export const dynamic = 'force-dynamic';

/**
 * POST — «Проверить доставку сейчас»: пробы с ящика на контрольные ящики
 * Gmail и Яндекса. Отправляет sender-воркер с ближайшим тактом, папки смотрит
 * через несколько минут; результат — в строке ящика и на «Контрольных ящиках».
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.seed_check' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const { data: mailbox } = await supabaseAdmin.from('sender_mailboxes').select('id, status').eq('id', id).maybeSingle();
    if (!mailbox) return jsonError('Ящик не найден', 404);
    if (mailbox.status !== 'verified') return jsonError('Ящик не прошёл проверку входа — сначала «Проверить вход»', 400);

    try {
      const queued = await queueManualSeedProbes(id);
      if (!queued.length) return jsonError('Нет рабочих контрольных ящиков — проверьте вкладку «Контрольные ящики»', 409);
      return NextResponse.json({ queued });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'Не удалось запустить проверку', 500);
    }
  });
}
