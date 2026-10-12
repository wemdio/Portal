import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeProject, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { stopHeEngProjectWork } from '@/lib/hypothesisEngine/engProjectStop';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

/**
 * POST — «Cancel all jobs»: остановить то, что СВОЙ проект делает и будет делать
 * сам: активные джобы he_jobs (research, цепочки, сборка/анализ баз, шаблоны,
 * ночной долив), автопилот, автозапуск, ночной добор, а у отменённых баз —
 * джобы конструктора и дочерние джобы Google Maps. Уже завершённые джобы и
 * готовые артефакты не трогаем.
 *
 * Записи и их порядок — stopHeEngProjectWork (lib/hypothesisEngine/
 * engProjectStop.ts, режим 'client'; та же функция в режиме 'staff_block'
 * останавливает проекты при блокировке аккаунта). Роут — проверки входа,
 * рынка и владения и ответ:
 *  - сбой записи автопилота — 500, ничего больше не записано;
 *  - сбой записи джоб — 500 (автопилот, автозапуск и пауза добора уже легли:
 *    повторное нажатие их не портит, записи идемпотентны);
 *  - иначе { ok: true, cancelled: <сколько джоб отменено> }; ноль — штатный
 *    ответ (автопилот выключен, отметка отмены записана, если есть колонка из
 *    20261009_0002, добор поставлен на паузу, если у проекта есть его конфиг и
 *    колонки паузы из 20260930_0005, застрявшие базы остановлены).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.cancel.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const stop = await stopHeEngProjectWork(supabaseAdmin, id, {
      by: 'client',
      now: new Date(),
      userId: result.auth.userId,
      projectStatus: (owned.project as { status?: string }).status,
    });
    if (stop.abort) {
      return engServerError(
        stop.abort.step === 'autopilot' ? 'client.eng.cancel.autopilot_failed' : 'client.eng.cancel.jobs_failed',
        stop.abort.error,
        'Failed to cancel the running jobs',
        { userId: result.auth.userId, projectId: id },
      );
    }

    return NextResponse.json({ ok: true, cancelled: typeof stop.jobs === 'number' ? stop.jobs : 0 });
  });
}
