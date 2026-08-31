import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { assertToolAllowed, authenticateBench, isBenchAuth } from '@/lib/bench/auth';
import { benchError } from '@/lib/bench/errors';
import { logBenchRequest } from '@/lib/bench/journal';
import { checkBenchLimits } from '@/lib/bench/limits';
import { getBenchTool } from '@/lib/bench/registry';
import { applyToolScope } from '@/lib/bench/scope';
import type { BenchJobTool } from '@/lib/bench/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const { id } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const toolId = sp.get('tool') ?? '';

  const finish = async (response: NextResponse, rows: number) => {
    await logBenchRequest({
      keyId: auth.key.id,
      tool: toolId || null,
      action: 'results',
      statusCode: response.status,
      // Отданные строки идут в журнал: по ним считается суточная норма, и
      // это главный ограничитель постепенной выкачки наших баз.
      rowsReturned: rows,
      durationMs: Date.now() - started,
    });
    return response;
  };

  const tool = getBenchTool(toolId);
  if (!tool || tool.kind !== 'job') {
    return finish(benchError('not_found', `Инструмент «${toolId}» не найден`), 0);
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied, 0);

  const limited = await checkBenchLimits(auth.key, 'results');
  if (limited) return finish(limited, 0);

  const jobTool = tool as BenchJobTool;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(sp.get('limit')) || DEFAULT_LIMIT));
  const cursor = sp.get('cursor');

  // Результаты у инструментов лежат двумя способами — в отдельной таблице
  // или массивом в самой строке задачи. Проверка «задача моя» в обоих
  // случаях идёт через клиент робота, то есть её выполняет RLS.
  if (jobTool.results.kind === 'inline') {
    const field = jobTool.results.field;
    const { data: job } = await applyToolScope(
      auth.db.from(jobTool.table).select(`id, ${field}`).eq('id', id),
      jobTool,
    ).maybeSingle();
    if (!job) return finish(benchError('not_found', 'Задача не найдена'), 0);

    const all = Array.isArray(job[field]) ? (job[field] as unknown[]) : [];
    // У элементов JSON-массива нет ни id, ни порядка, кроме позиции —
    // поэтому здесь курсор это номер элемента, а не идентификатор строки.
    const from = Math.max(0, Number(cursor) || 0);
    const page = all.slice(from, from + limit);
    const hasMore = from + page.length < all.length;

    return finish(
      NextResponse.json({
        rows: page,
        cursor: hasMore ? String(from + page.length) : null,
        has_more: hasMore,
      }),
      page.length,
    );
  }

  // Сперва убеждаемся, что задача видна роботу. Без этого пришлось бы
  // полагаться только на RLS дочерней таблицы, а она у разных инструментов
  // написана по-разному — родителя проверяем явно.
  const { data: job } = await applyToolScope(
    auth.db.from(jobTool.table).select('id').eq('id', id),
    jobTool,
  ).maybeSingle();
  if (!job) return finish(benchError('not_found', 'Задача не найдена'), 0);

  // Курсор, а не смещение: результаты дописываются воркером прямо во время
  // выгрузки, и offset на растущей таблице теряет и дублирует строки.
  let query = auth.db
    .from(jobTool.results.table)
    .select('*')
    .eq(jobTool.results.jobColumn, id)
    .order('id', { ascending: true })
    .limit(limit);
  if (cursor) query = query.gt('id', cursor);

  const { data, error } = await query;
  if (error) return finish(benchError('server_error', error.message), 0);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rows.length === limit;
  const last = rows[rows.length - 1];

  return finish(
    NextResponse.json({
      rows,
      cursor: hasMore && last ? String(last.id) : null,
      has_more: hasMore,
    }),
    rows.length,
  );
}
