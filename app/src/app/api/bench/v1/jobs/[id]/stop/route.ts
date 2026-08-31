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

const STOPPABLE_FROM = ['pending', 'queued', 'running', 'processing'];

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const { id } = await ctx.params;
  const toolId = req.nextUrl.searchParams.get('tool') ?? '';

  const finish = async (response: NextResponse) => {
    await logBenchRequest({
      keyId: auth.key.id,
      tool: toolId || null,
      action: 'stop',
      statusCode: response.status,
      rowsReturned: 0,
      durationMs: Date.now() - started,
    });
    return response;
  };

  const tool = getBenchTool(toolId);
  if (!tool || tool.kind !== 'job') {
    return finish(benchError('not_found', `Инструмент «${toolId}» не найден`));
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied);

  const limited = await checkBenchLimits(auth.key, 'stop');
  if (limited) return finish(limited);

  const jobTool = tool as BenchJobTool;

  // Остановку поддерживают не все инструменты: у большинства нет ни ручки,
  // ни статуса «остановлена» в ограничении таблицы. Отвечаем внятной
  // причиной, а `GET /tools` сообщает об этом заранее — чтобы внешний
  // разработчик не выяснял ограничение пробами.
  if (!jobTool.stop.supported) {
    return finish(benchError('conflict', jobTool.stop.reason));
  }

  const { data: job } = await applyToolScope(
    auth.db.from(jobTool.table).select('*').eq('id', id),
    jobTool,
  ).maybeSingle();
  if (!job) return finish(benchError('not_found', 'Задача не найдена'));

  if (!STOPPABLE_FROM.includes(String(job.status))) {
    return finish(benchError('conflict', 'Задача уже завершена — останавливать нечего'));
  }

  const { data, error } = await applyToolScope(
    auth.db.from(jobTool.table).update({ status: jobTool.stop.stoppedStatus }).eq('id', id),
    jobTool,
  )
    .select()
    .single();

  if (error || !data) {
    return finish(
      benchError('server_error', error?.message ?? 'Не удалось остановить задачу'),
    );
  }

  return finish(NextResponse.json(toBenchJobView(jobTool, data)));
}
