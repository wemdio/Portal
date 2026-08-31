import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authenticateBench, isBenchAuth } from '@/lib/bench/auth';
import { logBenchRequest } from '@/lib/bench/journal';
import { checkBenchLimits } from '@/lib/bench/limits';
import { describeBenchTool, listBenchTools } from '@/lib/bench/registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Каталог доступного этому ключу.
 *
 * Собирается из тех же zod-схем, по которым идёт проверка входа, поэтому не
 * может разойтись с реальным поведением витрины. Для внешнего разработчика
 * это означает, что параметры и ограничения (например, поддерживается ли
 * остановка) он узнаёт из ответа API, а не пробами и не из устаревшей
 * страницы документации.
 */
export async function GET(req: NextRequest) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const finish = async (response: NextResponse) => {
    await logBenchRequest({
      keyId: auth.key.id,
      tool: null,
      action: 'tools',
      statusCode: response.status,
      rowsReturned: 0,
      durationMs: Date.now() - started,
    });
    return response;
  };

  const limited = await checkBenchLimits(auth.key, 'read');
  if (limited) return finish(limited);

  const tools = listBenchTools(auth.key.allowed_tools).map(describeBenchTool);
  return finish(NextResponse.json({ tools }));
}
