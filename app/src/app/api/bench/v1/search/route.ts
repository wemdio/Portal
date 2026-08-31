import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { assertToolAllowed, authenticateBench, isBenchAuth } from '@/lib/bench/auth';
import { benchError } from '@/lib/bench/errors';
import { logBenchRequest } from '@/lib/bench/journal';
import { checkBenchLimits } from '@/lib/bench/limits';
import { getBenchTool } from '@/lib/bench/registry';
import type { BenchSearchTool } from '@/lib/bench/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * Поиск по уже собранным базам. В отличие от задач, отвечает сразу: очереди
 * и воркера здесь нет, читается то, что уже лежит.
 */
export async function POST(req: NextRequest) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  let body: { source?: unknown; filters?: unknown; limit?: unknown; cursor?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return benchError('invalid_params', 'Тело запроса должно быть JSON');
  }

  const sourceId = typeof body.source === 'string' ? body.source : '';

  const finish = async (response: NextResponse, rows: number) => {
    await logBenchRequest({
      keyId: auth.key.id,
      tool: sourceId || null,
      action: 'search',
      statusCode: response.status,
      // Норма строк общая с выгрузкой результатов задач: и то и другое
      // выносит данные наружу.
      rowsReturned: rows,
      durationMs: Date.now() - started,
    });
    return response;
  };

  const tool = getBenchTool(sourceId);
  if (!tool || tool.kind !== 'search') {
    return finish(
      benchError('not_found', `Источник «${sourceId}» не найден среди поисковых`),
      0,
    );
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied, 0);

  const limited = await checkBenchLimits(auth.key, 'search');
  if (limited) return finish(limited, 0);

  const searchTool = tool as BenchSearchTool;
  const parsed = searchTool.filtersSchema.safeParse(body.filters ?? {});
  if (!parsed.success) {
    return finish(
      benchError('invalid_params', 'Фильтры не прошли проверку', parsed.error.issues),
      0,
    );
  }

  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(body.limit) || DEFAULT_LIMIT));
  const cursor = typeof body.cursor === 'string' ? body.cursor : null;

  try {
    const page = await searchTool.run({ db: auth.db, filters: parsed.data, limit, cursor });
    return finish(NextResponse.json(page), page.rows.length);
  } catch (e) {
    return finish(
      benchError('server_error', e instanceof Error ? e.message : 'Поиск не удался'),
      0,
    );
  }
}
