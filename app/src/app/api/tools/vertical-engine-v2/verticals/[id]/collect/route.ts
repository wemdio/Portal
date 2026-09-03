import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { enqueueVeBaseCollect } from '@/lib/verticalEngineV2/baseCollectEnqueue';
import { VE_PREVIEW_READY_TARGET, VE_COLLECTION_MAX_CANDIDATES } from '@/lib/verticalEngineV2/collectionTarget';
import { stripTaskHarvest } from '@/lib/verticalEngineV2/projectDetail';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// POST — запустить авто-сборку базы под вертикаль (стадия base_collect: план
// источников → коллекторы → harvest в ve_bases). Создаёт ve_bases
// (source='auto', status='collecting') + ve_jobs (stage='base_collect').
// Каждый новый ручной запуск готовит превью по явно выбранным гипотезам.
// Старый client-supplied limit больше не управляет сбором: цель задаёт сервер.
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

      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
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
      if (!hypothesisIds?.length) return jsonError('Выберите хотя бы одну гипотезу для превью', 400);

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
        limit: VE_COLLECTION_MAX_CANDIDATES,
        collectionMode: 'preview',
        readyTarget: VE_PREVIEW_READY_TARGET,
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
        return NextResponse.json({ ok: true, existing: true, base: stripTaskHarvest(result.base) });
      }

      void logAudit('tools.vertical-engine-v2.collect.enqueued', 'Hypothesis engine auto-collect enqueued', {
        userId,
        verticalId: id,
        baseId: result.base.id,
        basesCount: result.bases.length,
      });

      return NextResponse.json({
        ok: true, base: stripTaskHarvest(result.base), bases: result.bases.map(stripTaskHarvest),
      }, { status: 201 });
    },
  );
}
