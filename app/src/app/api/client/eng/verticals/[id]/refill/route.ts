import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeVertical, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { resumeHeVerticalNightlyRefill } from '@/lib/hypothesisEngine/autoPipeline';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

// Текст уезжает клиенту как есть (engServerError → тело ответа → engErrorText,
// английская строка проходит скраб насквозь). Поэтому он называет действие ТЕМ
// ЖЕ словом, что и кнопка кабинета, — «auto-refill» (EngStepVerticals.tsx):
// отказ, говорящий про «nightly top-ups», отсылал бы к действию, которого в
// кабинете нет.
const RESUME_FAILED = 'Failed to resume the auto-refill';

// POST — «Resume auto-refill»: отменить решение правила сухой вертикали.
//
// Ночной проход снимает вертикаль с добора, когда N подряд ночей не добавили ни
// одного контакта (lib/hypothesisEngine/autoPipeline.ts, блок «СУХАЯ
// ВЕРТИКАЛЬ»). Это единственный способ вернуть её обратно — и именно поэтому
// роут существует: остановка, которую нельзя отменить из того же места, где её
// видно, неотличима для клиента от поломки.
//
// Тела нет: у действия один смысл и один исход. Идемпотентен — повторное
// нажатие просто заново открывает окно серии (штамп refill_resumed_at), а
// пометка и так снята.
//
// Границы. РЫНОК проверяется (requireEngMarket): правило живёт только в ENG-
// контуре, вертикали RU staff-инструмента ночной добор he_* не обслуживает
// вовсе (тик берёт только проекты market='us'), и открывать им этот роут
// незачем. Владелец — loadClientHeVertical: чужая вертикаль отвечает 404,
// существование её не раскрывается. Статуса проекта здесь нет: пометка может
// стоять на вертикали любого запущенного проекта, и запрещать возврат по
// состоянию конвейера было бы отказом без причины.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.refill_resume.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeVertical(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    try {
      await resumeHeVerticalNightlyRefill(supabaseAdmin, id);
    } catch (e) {
      return engServerError(
        'client.eng.refill_resume.failed',
        e instanceof Error ? e : new Error(String(e)),
        RESUME_FAILED,
        { userId: result.auth.userId, verticalId: id },
      );
    }

    void logAudit('client.eng.refill_resume.done', 'ENG cabinet nightly refill resumed', {
      userId: result.auth.userId,
      verticalId: id,
      projectId: owned.vertical.project_id,
    });

    return NextResponse.json({ ok: true });
  });
}
