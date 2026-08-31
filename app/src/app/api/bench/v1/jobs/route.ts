import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { assertToolAllowed, authenticateBench, isBenchAuth } from '@/lib/bench/auth';
import { benchError } from '@/lib/bench/errors';
import { toBenchJobView } from '@/lib/bench/jobView';
import { logBenchRequest } from '@/lib/bench/journal';
import { checkActiveJobs, checkBenchLimits } from '@/lib/bench/limits';
import { getBenchTool } from '@/lib/bench/registry';
import { applyToolScope } from '@/lib/bench/scope';
import type { BenchJobTool } from '@/lib/bench/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Незавершённые статусы — объединение словарей всех задачных таблиц: у
 * конструктора баз `pending/processing`, у Google Maps `queued`, у Яндекс.Карт
 * `pending/running`. Держим общий список: лишнее значение в нём безвредно,
 * недостающее — дыра в потолке одновременных задач.
 */
const ACTIVE_STATUSES = ['pending', 'queued', 'running', 'processing'];

const LIST_LIMIT = 100;

export async function POST(req: NextRequest) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const finish = async (response: NextResponse, tool: string | null) => {
    await logBenchRequest({
      keyId: auth.key.id,
      tool,
      action: 'create_job',
      statusCode: response.status,
      rowsReturned: 0,
      durationMs: Date.now() - started,
    });
    return response;
  };

  let body: { tool?: unknown; params?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return finish(benchError('invalid_params', 'Тело запроса должно быть JSON'), null);
  }

  const toolId = typeof body.tool === 'string' ? body.tool : '';
  const tool = getBenchTool(toolId);
  if (!tool || tool.kind !== 'job') {
    return finish(
      benchError('not_found', `Инструмент «${toolId}» не найден среди задачных`),
      toolId || null,
    );
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied, tool.id);

  const limited = await checkBenchLimits(auth.key, 'create_job');
  if (limited) return finish(limited, tool.id);

  const jobTool = tool as BenchJobTool;
  const parsed = jobTool.paramsSchema.safeParse(body.params ?? {});
  if (!parsed.success) {
    return finish(
      benchError('invalid_params', 'Параметры не прошли проверку', parsed.error.issues),
      tool.id,
    );
  }

  const busy = await checkActiveJobs(auth.db, auth.key, jobTool.table, ACTIVE_STATUSES);
  if (busy) return finish(busy, tool.id);

  // Владелец берётся ИЗ КЛЮЧА, а не из тела запроса — подделать его нельзя.
  // Схемы адаптеров вдобавок строгие (`.strict()`), поэтому попытка прислать
  // user_id отвергается ещё на проверке параметров.
  const row = jobTool.buildRow(parsed.data, auth.key.robot_user_id);
  const { data, error } = await auth.db.from(jobTool.table).insert(row).select().single();

  if (error || !data) {
    return finish(
      benchError('server_error', error?.message ?? 'Не удалось создать задачу'),
      tool.id,
    );
  }

  return finish(NextResponse.json(toBenchJobView(jobTool, data)), tool.id);
}

export async function GET(req: NextRequest) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const finish = async (response: NextResponse, tool: string | null, rows: number) => {
    await logBenchRequest({
      keyId: auth.key.id,
      tool,
      action: 'list_jobs',
      statusCode: response.status,
      rowsReturned: rows,
      durationMs: Date.now() - started,
    });
    return response;
  };

  const toolId = req.nextUrl.searchParams.get('tool') ?? '';
  if (!toolId) {
    return finish(
      benchError('invalid_params', 'Укажите ?tool= — список задач ведётся по инструменту'),
      null,
      0,
    );
  }

  const tool = getBenchTool(toolId);
  if (!tool || tool.kind !== 'job') {
    return finish(benchError('not_found', `Инструмент «${toolId}» не найден`), toolId, 0);
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied, tool.id, 0);

  const limited = await checkBenchLimits(auth.key, 'read');
  if (limited) return finish(limited, tool.id, 0);

  const jobTool = tool as BenchJobTool;
  // Фильтра по user_id здесь нет намеренно: клиент привязан к роботу, и чужие
  // строки отсекает RLS на уровне базы. Тест benchIsolation стережёт, чтобы
  // этот роут не начал ходить сервисным ключом, который RLS обходит.
  const { data, error } = await applyToolScope(
    auth.db.from(jobTool.table).select('*'),
    jobTool,
  )
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);

  if (error) return finish(benchError('server_error', error.message), tool.id, 0);

  const wanted = req.nextUrl.searchParams.get('status');
  const jobs = (data ?? [])
    .map((row) => toBenchJobView(jobTool, row))
    .filter((job) => !wanted || job.status === wanted);

  return finish(NextResponse.json({ jobs }), tool.id, jobs.length);
}
