import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { enqueueVeBaseCollect } from '@/lib/verticalEngineV2/baseCollectEnqueue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// POST — запустить авто-сборку базы под вертикаль (стадия base_collect: план
// источников → коллекторы → harvest в ve_bases). Создаёт ve_bases
// (source='auto', status='collecting') + ve_jobs (stage='base_collect').
// Тело опционально: {limit?: 2000 | 10000 | 50000, hypothesis_ids?: string[]}.
// limit — лимит строк сборки (практический предохранитель от раздутого data
// jsonb; выбор — за пользователем, дефолт 10000). hypothesis_ids — выбранные
// в UI гипотезы: массив непустых строк (иначе 400); пустой массив равноценен
// отсутствию поля. Лимит и непустой hypothesis_ids едут в payload джобы (их
// читают totalRowsCap и buildPlan в стадии) и в ve_bases.collect_info (его
// показывает UI).
// Дедуп и вставки — в lib/verticalEngineV2/baseCollectEnqueue.ts (им же
// пользуется клиентский ENG-контур): активная сборка этой вертикали →
// 200 + existing, иначе 201; гонку параллельных запусков закрывает
// partial unique index ve_bases_one_collecting_per_vertical.
/** Допустимые лимиты строк авто-сборки (см. UI Step4Base). */
const ALLOWED_LIMITS: readonly number[] = [2000, 10000, 50000];
const DEFAULT_LIMIT = 10000;
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.collect.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      // Тело опционально (пустое/не-JSON — ок): лимит строк из выбора
      // пользователя, любое значение вне ALLOWED_LIMITS — 400.
      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      let limit = DEFAULT_LIMIT;
      if (body && typeof body === 'object' && 'limit' in body) {
        const raw = (body as { limit?: unknown }).limit;
        if (raw !== undefined) {
          if (typeof raw !== 'number' || !ALLOWED_LIMITS.includes(raw)) {
            return jsonError('limit должен быть одним из: 2000, 10000, 50000', 400);
          }
          limit = raw;
        }
      }

      // Выбор гипотез из UI (шаг 4): массив непустых строк или отсутствие
      // поля; пустой массив трактуем как «поля нет» (стадия фильтрует план
      // только по непустому массиву — иначе «снял все галочки» молча собирало
      // бы по всем гипотезам, а UI в таком состоянии кнопку блокирует).
      let hypothesisIds: string[] | null = null;
      if (body && typeof body === 'object' && 'hypothesis_ids' in body) {
        const raw = (body as { hypothesis_ids?: unknown }).hypothesis_ids;
        if (raw !== undefined) {
          if (
            !Array.isArray(raw) ||
            raw.some((v) => typeof v !== 'string' || v.length === 0)
          ) {
            return jsonError('hypothesis_ids должен быть массивом непустых строк', 400);
          }
          hypothesisIds = raw.length > 0 ? raw : null;
        }
      }

      const { data: vertical, error: vertErr } = await supabaseAdmin
        .from('ve_verticals')
        .select('id, project_id, name')
        .eq('id', id)
        .single();
      if (vertErr) {
        return jsonError(
          vertErr.code === 'PGRST116' ? 'Вертикаль не найдена' : vertErr.message,
          vertErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      const result = await enqueueVeBaseCollect(supabaseAdmin, {
        verticalId: id,
        projectId: vertical.project_id,
        verticalName: vertical.name,
        limit,
        hypothesisIds,
      });
      if (!result.ok) {
        await logError('tools.vertical-engine-v2.collect.enqueue_failed', new Error(result.message), {
          userId,
          verticalId: id,
        });
        return jsonError(result.message, 500);
      }
      if (!result.created) {
        return NextResponse.json({ ok: true, existing: true, base: result.base });
      }

      void logAudit('tools.vertical-engine-v2.collect.enqueued', 'Hypothesis engine auto-collect enqueued', {
        userId,
        verticalId: id,
        baseId: result.base.id,
      });

      return NextResponse.json({ ok: true, base: result.base }, { status: 201 });
    },
  );
}
