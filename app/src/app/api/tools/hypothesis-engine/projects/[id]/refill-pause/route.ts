import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { readHeRefillPause, resumeHeRefillPause } from '@/lib/hypothesisEngine/autoPipeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Пауза ночного добора по ЁМКОСТИ воркспейса рассыльщика и возврат из неё.
 *
 * ПОЧЕМУ ЭТА РУЧКА ЖИВЁТ В STAFF-ИНСТРУМЕНТЕ, А НЕ В КАБИНЕТЕ. Возобновление
 * начинает платную работу у провайдера (ночная сборка: план источников, гейт,
 * краул, SMTP-проба каждого адреса). Мутирующая ручка в ENG-кабинете отдала бы
 * это право клиенту. Сотрудник же и так разбирает переполненный воркспейс —
 * кнопка стоит там, где он работает.
 *
 * ПОЧЕМУ БЕЗ ЭТОЙ РУЧКИ МЕХАНИЗМ НЕЛЬЗЯ ВЫКАТЫВАТЬ. Паузу ставит автоматика
 * (предполёт ёмкости в ночном тике либо отказ провайдера на доливе), а
 * автоснятия по таймеру у неё нет намеренно. Единственный путь назад — этот
 * роут; без него пауза усыпила бы проект навсегда.
 *
 * ПАУЗУ ЗДЕСЬ НЕ СТАВЯТ. Ставить её вручную незачем: «не хотим ночного
 * добора» — это he_auto_pipeline_configs.enabled, отдельный и давно
 * существующий выключатель, а пауза означает «хотим, но физически некуда», и
 * такое наблюдение делает не человек, а рассыльщик.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.refill-pause.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let state;
      try {
        state = await readHeRefillPause(supabaseAdmin, id);
      } catch (e) {
        await logError('tools.hypothesis-engine.refill-pause.read_failed', e, { projectId: id });
        return jsonError('Не удалось прочитать состояние ночного добора', 500);
      }

      // Ответ перечисляет ВЕСЬ набор состояний, а не только «на паузе / не на
      // паузе»: «конфига добора нет» и «колонок паузы нет на окружении» — это
      // разные ответы сотруднику (разбирать нечего против чинить выкат), и
      // схлопывать их в false значило бы врать обоим.
      switch (state.kind) {
        case 'unsupported':
          return NextResponse.json({ supported: false, configured: false, paused: false });
        case 'no_config':
          return NextResponse.json({ supported: true, configured: false, paused: false });
        case 'running':
          return NextResponse.json({
            supported: true,
            configured: true,
            paused: false,
            resumed_at: state.resumedAt,
          });
        case 'active':
          return NextResponse.json({
            supported: true,
            configured: true,
            paused: true,
            paused_at: state.pausedAt,
            reason: state.reason,
            resumed_at: state.resumedAt,
          });
      }
    },
  );
}

/**
 * POST — вернуть проект в ночной добор. Снимает refill_paused_at и ставит
 * refill_resumed_at; ближайший тик крона (03:20 UTC) снова поставит сборки.
 *
 * Тело не читается: у действия один смысл и один аргумент — сам проект.
 * Повторное нажатие отвечает 409 «уже работает», а не тихим ok: сотруднику
 * важно знать, что он ничего не менял.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.refill-pause.resume' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let outcome;
      try {
        outcome = await resumeHeRefillPause(supabaseAdmin, id);
      } catch (e) {
        await logError('tools.hypothesis-engine.refill-pause.resume_failed', e, {
          userId,
          projectId: id,
        });
        return jsonError('Не удалось возобновить ночной добор', 500);
      }

      switch (outcome) {
        case 'unsupported':
          return jsonError(
            'Пауза ночного добора не поддержана окружением: не прокатана миграция 20260930_0005',
            409,
          );
        case 'no_config':
          return jsonError('У проекта нет конфига ночного добора — возобновлять нечего', 409);
        case 'not_paused':
          return jsonError('Ночной добор проекта не на паузе', 409);
        case 'resumed':
          // Возобновление — действие, за которое платит студия: следующая ночь
          // снова покупает сборку. В аудит оно идёт вместе с тем, кто нажал.
          void logAudit(
            'tools.hypothesis-engine.refill_resumed',
            'HE nightly refill resumed after workspace capacity pause',
            { userId, projectId: id },
          );
          return NextResponse.json({ ok: true, resumed: true });
      }
    },
  );
}
