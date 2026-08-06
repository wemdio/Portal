import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { loadClientHeVertical } from '@/lib/hypothesisEngine/apiGuards';
import { enqueueHeBaseCollect } from '@/lib/hypothesisEngine/baseCollectEnqueue';

export const dynamic = 'force-dynamic';

/** Лимиты авто-сборки для кабинета: консервативнее staff-набора (там есть 50000). */
const ALLOWED_LIMITS: readonly number[] = [2000, 10000];
const DEFAULT_LIMIT = 2000;

// POST — запустить авто-сборку базы под СВОЮ вертикаль. Тело опционально:
// {limit?: 2000 | 10000, hypothesis_ids?: string[]} (дефолт лимита кабинета —
// 2000). Дедуп и вставки — общие со staff (enqueueHeBaseCollect): уже идущая
// сборка → 200 + existing, иначе 201.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
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
        return jsonError('limit must be one of: 2000, 10000', 400);
      }
      limit = raw;
    }
  }

  // Выбор гипотез из UI: массив непустых строк или отсутствие поля; пустой
  // массив трактуем как «поля нет» (см. комментарий в staff-роуте).
  let hypothesisIds: string[] | null = null;
  if (body && typeof body === 'object' && 'hypothesis_ids' in body) {
    const raw = (body as { hypothesis_ids?: unknown }).hypothesis_ids;
    if (raw !== undefined) {
      if (
        !Array.isArray(raw) ||
        raw.some((v) => typeof v !== 'string' || v.length === 0)
      ) {
        return jsonError('hypothesis_ids must be an array of non-empty strings', 400);
      }
      hypothesisIds = raw.length > 0 ? raw : null;
    }
  }

  const owned = await loadClientHeVertical(supabaseAdmin, id, result.auth.userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

  const collect = await enqueueHeBaseCollect(supabaseAdmin, {
    verticalId: id,
    projectId: owned.vertical.project_id as string,
    verticalName: owned.vertical.name as string,
    limit,
    hypothesisIds,
  });
  if (!collect.ok) {
    await logError('client.eng.collect.enqueue_failed', new Error(collect.message), {
      userId: result.auth.userId,
      verticalId: id,
    });
    return jsonError(collect.message, 500);
  }
  if (!collect.created) {
    return NextResponse.json({ ok: true, existing: true, base: collect.base });
  }

  void logAudit('client.eng.collect.enqueued', 'ENG cabinet auto-collect enqueued', {
    userId: result.auth.userId,
    verticalId: id,
    baseId: collect.base.id,
  });

  return NextResponse.json({ ok: true, base: collect.base }, { status: 201 });
}
