import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { assertToolAllowed, authenticateBench, isBenchAuth } from '@/lib/bench/auth';
import { benchError } from '@/lib/bench/errors';
import { toBenchJobView } from '@/lib/bench/jobView';
import { logBenchRequest } from '@/lib/bench/journal';
import { checkBenchLimits } from '@/lib/bench/limits';
import { getBenchTool } from '@/lib/bench/registry';
import { applyToolScope } from '@/lib/bench/scope';
import type { BenchJobTool } from '@/lib/bench/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const { id } = await ctx.params;
  const toolId = req.nextUrl.searchParams.get('tool') ?? '';

  const finish = async (response: NextResponse) => {
    await logBenchRequest({
      keyId: auth.key.id,
      tool: toolId || null,
      action: 'job_status',
      statusCode: response.status,
      rowsReturned: 0,
      durationMs: Date.now() - started,
    });
    return response;
  };

  // Идентификатор задачи уникален только внутри своей таблицы, а таблиц у нас
  // пятнадцать — поэтому инструмент нужно назвать явно.
  if (!toolId) {
    return finish(
      benchError('invalid_params', 'Укажите ?tool= — задачи хранятся по инструментам'),
    );
  }

  const tool = getBenchTool(toolId);
  if (!tool || tool.kind !== 'job') {
    return finish(benchError('not_found', `Инструмент «${toolId}» не найден`));
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied);

  const limited = await checkBenchLimits(auth.key, 'read');
  if (limited) return finish(limited);

  const jobTool = tool as BenchJobTool;
  // Разграничение обязательно: HH, ATS и англоязычный найм делят таблицу, и
  // без него запрос «?tool=hh» по идентификатору ATS-задачи выдал бы её как
  // HH-задачу — с чужим смыслом полей и чужой таблицей результатов.
  const { data } = await applyToolScope(
    auth.db.from(jobTool.table).select('*').eq('id', id),
    jobTool,
  ).maybeSingle();

  // Чужая задача просто не вернётся: клиент привязан к роботу, и RLS отсекает
  // её на уровне базы. Отвечаем `not_found`, а не `forbidden`, чтобы перебором
  // идентификаторов нельзя было выяснить, что существует у других.
  if (!data) return finish(benchError('not_found', 'Задача не найдена'));

  return finish(NextResponse.json(toBenchJobView(jobTool, data)));
}
