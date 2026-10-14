import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isValidUuid } from '@/lib/apiValidation';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  advanceHeBaseRevalidation,
  diagnoseHeBaseRecovery,
  importHeLateConstructForBase,
  type HeRecoveryRefusal,
} from '@/lib/hypothesisEngine/validationRetry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Поздний импорт читает сетку конструктора и `data` всех баз проекта, а шаг
// перепроверки — `data` самой базы (до 50 000 строк), как тик импорта стадии.
export const maxDuration = 300;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function refused(refusal: HeRecoveryRefusal) {
  return NextResponse.json(
    { error: refusal.message, code: refusal.code },
    { status: refusal.code === 'base_not_found' ? 404 : 409 },
  );
}

const RACED = 'Базу записали между чтением и записью — ничего не изменено, повторите вызов';

/**
 * Восстановление адресов авто-базы БЕЗ новой сборки — только market='us',
 * только staff (lib/hypothesisEngine/validationRetry.ts, там же правила).
 *
 * GET — диагноз без записей: доступен ли поздний импорт и перепроверка, почему
 * нет (code + текст), сколько адресов без вердикта, раунд в полёте и итог
 * прошлого раунда.
 *
 * POST {action: 'import_late'} — принять результат джобы конструктора, которая
 * закончилась после того, как сборка перестала её ждать: база 'failed' →
 * 'analyzing' + base_analyze. Повтор после успешного импорта только
 * доставляет анализ.
 *
 * POST {action: 'revalidate', restart?: boolean} — ОДИН шаг перепроверки
 * сохранённых адресов: закрыть законченный раунд (вердикты → строки базы),
 * затем поставить следующий (≤ 200 адресов, джоба конструктора только с
 * validate_emails). Раунд в полёте — ответ про него, ничего не ставится.
 * `restart: true` начинает проход с первой строки (после того как сотрудник
 * убедился, что валидатор снова жив). Вызывать повторно, пока
 * `pass_complete: false` и `round !== null`.
 *
 * Сами пути платных вызовов (Requesty, Serper) не делают: перепроверка —
 * SMTP-пробы через наш прокси; поздний импорт — чтения и запись, после
 * которых встаёт base_analyze (один вызов модели) — тот же анализ, что
 * поставила бы сама сборка, дождись она конструктора.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.bases.revalidate.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);
      if (!isValidUuid(id)) return jsonError('Invalid id', 400);
      try {
        const diagnosis = await diagnoseHeBaseRecovery(supabaseAdmin, id);
        if (!diagnosis) return jsonError('База не найдена', 404);
        return NextResponse.json({ ok: true, ...diagnosis });
      } catch (e) {
        await logError('tools.hypothesis-engine.bases.revalidate.diagnose_failed', e, {
          userId: authed.auth.userId,
          baseId: id,
        });
        return jsonError(e instanceof Error ? e.message : String(e), 500);
      }
    },
  );
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.bases.revalidate.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);
      if (!isValidUuid(id)) return jsonError('Invalid id', 400);

      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      const action = body && typeof body === 'object' ? (body as { action?: unknown }).action : undefined;
      if (action !== 'import_late' && action !== 'revalidate') {
        return jsonError("action должен быть 'import_late' или 'revalidate'", 400);
      }
      const restartRaw = body && typeof body === 'object' ? (body as { restart?: unknown }).restart : undefined;
      if (restartRaw !== undefined && typeof restartRaw !== 'boolean') {
        return jsonError('restart должен быть true или false', 400);
      }

      const log: string[] = [];
      const push = (m: string) => {
        log.push(m);
      };
      try {
        if (action === 'import_late') {
          const outcome = await importHeLateConstructForBase(supabaseAdmin, id, push);
          if (outcome.kind === 'refused') return refused(outcome.refusal);
          if (outcome.kind === 'raced') return NextResponse.json({ error: RACED, code: 'raced' }, { status: 409 });
          void logAudit('tools.hypothesis-engine.bases.late_import', 'Late constructor result imported into a failed base', {
            userId,
            baseId: id,
            outcome: outcome.kind,
            rows: outcome.rows,
            analysis: outcome.analysis,
          });
          return NextResponse.json({ ok: true, outcome: outcome.kind, ...outcome, log });
        }
        const outcome = await advanceHeBaseRevalidation(supabaseAdmin, id, { restart: restartRaw === true }, push);
        if (outcome.kind === 'refused') return refused(outcome.refusal);
        if (outcome.kind === 'raced') return NextResponse.json({ error: RACED, code: 'raced' }, { status: 409 });
        if (outcome.closed || outcome.round) {
          void logAudit('tools.hypothesis-engine.bases.revalidate', 'Saved email revalidation step', {
            userId,
            baseId: id,
            closed: outcome.closed,
            round: outcome.round?.bc_job_id ?? null,
            remaining: outcome.remaining,
          });
        }
        return NextResponse.json({ ok: true, ...outcome, log });
      } catch (e) {
        await logError('tools.hypothesis-engine.bases.revalidate.failed', e, { userId, baseId: id, action });
        return NextResponse.json({ error: e instanceof Error ? e.message : String(e), log }, { status: 500 });
      }
    },
  );
}
